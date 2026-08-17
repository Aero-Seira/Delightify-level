package io.github.aeroseira.mpide_exporter.client;

import com.mojang.blaze3d.pipeline.TextureTarget;
import com.mojang.blaze3d.platform.Lighting;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.VertexSorting;
import com.mojang.logging.LogUtils;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.client.ClientHooks;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.joml.Matrix4f;
import org.slf4j.Logger;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;

/** 在客户端 tick 中分批渲染物品最终态图标。 */
final class ClientIconRenderQueue {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final int ICON_SIZE = IconCache.ICON_SIZE;
    private static final int VANILLA_ICON_SIZE = 16;
    private static final int ATLAS_SIZE = 1024;
    private static final int COLUMNS = ATLAS_SIZE / ICON_SIZE;
    private static final int BATCH_SIZE = COLUMNS * COLUMNS;
    private static final Queue<RenderJob> JOBS = new ConcurrentLinkedQueue<>();
    private static final AtomicBoolean REGISTERED = new AtomicBoolean(false);

    private static RenderJob activeJob;

    private ClientIconRenderQueue() {}

    record IconRequest(String itemId, ItemStack stack, Path cachePath) {}

    record IconResult(String itemId, Path cachePath, byte[] png) {}

    static CompletableFuture<List<IconResult>> submit(List<IconRequest> requests) {
        ensureRegistered();
        CompletableFuture<List<IconResult>> future = new CompletableFuture<>();
        if (requests.isEmpty()) {
            future.complete(List.of());
            return future;
        }

        JOBS.add(new RenderJob(List.copyOf(requests), future));
        return future;
    }

    private static void ensureRegistered() {
        if (REGISTERED.compareAndSet(false, true)) {
            NeoForge.EVENT_BUS.addListener(ClientTickEvent.Post.class, ClientIconRenderQueue::onClientTick);
        }
    }

    private static void onClientTick(ClientTickEvent.Post event) {
        if (activeJob == null) {
            activeJob = JOBS.poll();
        }
        if (activeJob == null) {
            return;
        }

        try {
            activeJob.renderNextBatch();
            if (activeJob.isComplete()) {
                activeJob.complete();
                activeJob = null;
            }
        } catch (Exception exception) {
            activeJob.fail(exception);
            activeJob = null;
        }
    }

    private static final class RenderJob {
        private final List<IconRequest> requests;
        private final CompletableFuture<List<IconResult>> future;
        private final List<IconResult> results = new ArrayList<>();
        private int cursor;

        private RenderJob(List<IconRequest> requests, CompletableFuture<List<IconResult>> future) {
            this.requests = requests;
            this.future = future;
        }

        private void renderNextBatch() throws Exception {
            int end = Math.min(cursor + BATCH_SIZE, requests.size());
            List<IconRequest> batch = requests.subList(cursor, end);
            results.addAll(renderBatch(batch));
            cursor = end;
        }

        private boolean isComplete() {
            return cursor >= requests.size();
        }

        private void complete() {
            future.complete(List.copyOf(results));
        }

        private void fail(Exception exception) {
            future.completeExceptionally(exception);
        }
    }

    private static List<IconResult> renderBatch(List<IconRequest> batch) throws Exception {
        Minecraft minecraft = Minecraft.getInstance();
        TextureTarget atlas = new TextureTarget(ATLAS_SIZE, ATLAS_SIZE, true, Minecraft.ON_OSX);
        var modelViewStack = RenderSystem.getModelViewStack();
        boolean modelViewPushed = false;
        try {
            RenderSystem.backupProjectionMatrix();
            modelViewStack.pushMatrix();
            modelViewPushed = true;
            atlas.setClearColor(0.0F, 0.0F, 0.0F, 0.0F);
            atlas.clear(Minecraft.ON_OSX);
            atlas.bindWrite(true);
            RenderSystem.setProjectionMatrix(
                new Matrix4f().setOrtho(0.0F, ATLAS_SIZE, ATLAS_SIZE, 0.0F, 1000.0F, ClientHooks.getGuiFarPlane()),
                VertexSorting.ORTHOGRAPHIC_Z
            );
            modelViewStack.translation(0.0F, 0.0F, 10000.0F - ClientHooks.getGuiFarPlane());
            RenderSystem.applyModelViewMatrix();
            Lighting.setupFor3DItems();

            GuiGraphics gui = new GuiGraphics(minecraft, minecraft.renderBuffers().bufferSource());
            boolean[] rendered = new boolean[batch.size()];
            for (int index = 0; index < batch.size(); index++) {
                IconRequest request = batch.get(index);
                int x = (index % COLUMNS) * ICON_SIZE;
                int y = (index / COLUMNS) * ICON_SIZE;
                try {
                    gui.pose().pushPose();
                    gui.pose().translate(x, y, 0.0F);
                    gui.pose().scale((float) ICON_SIZE / VANILLA_ICON_SIZE, (float) ICON_SIZE / VANILLA_ICON_SIZE, 1.0F);
                    gui.renderItem(request.stack(), 0, 0);
                    rendered[index] = true;
                } catch (Exception exception) {
                    LOGGER.debug("跳过物品 {} 的客户端图标渲染", request.itemId(), exception);
                } finally {
                    gui.pose().popPose();
                }
            }
            gui.flush();

            atlas.bindRead();
            try (NativeImage image = new NativeImage(ATLAS_SIZE, ATLAS_SIZE, false)) {
                image.downloadTexture(0, false);
                image.flipY();
                return extractIcons(image, batch, rendered);
            } finally {
                atlas.unbindRead();
            }
        } finally {
            atlas.destroyBuffers();
            Minecraft.getInstance().getMainRenderTarget().bindWrite(true);
            if (modelViewPushed) {
                modelViewStack.popMatrix();
                RenderSystem.applyModelViewMatrix();
            }
            RenderSystem.restoreProjectionMatrix();
        }
    }

    private static List<IconResult> extractIcons(NativeImage atlas, List<IconRequest> batch, boolean[] rendered) throws Exception {
        List<IconResult> rows = new ArrayList<>();
        for (int index = 0; index < batch.size(); index++) {
            if (!rendered[index]) {
                continue;
            }
            IconRequest request = batch.get(index);
            int x = (index % COLUMNS) * ICON_SIZE;
            int y = (index / COLUMNS) * ICON_SIZE;
            try (NativeImage icon = new NativeImage(ICON_SIZE, ICON_SIZE, false)) {
                atlas.copyRect(icon, x, y, 0, 0, ICON_SIZE, ICON_SIZE, false, false);
                if (!hasVisiblePixel(icon)) {
                    LOGGER.debug("跳过物品 {} 的客户端图标结果：渲染后仍为全透明", request.itemId());
                    continue;
                }
                rows.add(new IconResult(request.itemId(), request.cachePath(), icon.asByteArray()));
            }
        }
        return rows;
    }

    private static boolean hasVisiblePixel(NativeImage image) {
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if (((image.getPixelRGBA(x, y) >>> 24) & 0xFF) != 0) {
                    return true;
                }
            }
        }
        return false;
    }
}
