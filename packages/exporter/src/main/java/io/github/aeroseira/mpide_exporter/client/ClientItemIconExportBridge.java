package io.github.aeroseira.mpide_exporter.client;

import com.mojang.logging.LogUtils;
import io.github.aeroseira.mpide_exporter.source.ItemRegistrySource;
import io.github.aeroseira.mpide_exporter.source.ItemResourceSource;
import net.minecraft.client.Minecraft;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.packs.repository.Pack;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.slf4j.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** 物理客户端专用：复用游戏物品栏渲染最终态导出图标。 */
public final class ClientItemIconExportBridge {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String RESOURCE_TYPE_TEXTURE = "texture";
    private static final String RENDERED_NAMESPACE = "mpide_exporter";
    private static final long RENDER_TIMEOUT_SECONDS = 120;

    private ClientItemIconExportBridge() {}

    public static List<ItemResourceSource.ItemResourceRow> capture(
        MinecraftServer server,
        List<ItemRegistrySource.ItemRow> items,
        Path exportDir,
        Map<String, String> manifest,
        Consumer<String> progress
    ) throws Exception {
        Minecraft minecraft = Minecraft.getInstance();
        IconCache cache = new IconCache(exportDir, manifest, resourcePackSignature(minecraft));
        List<ItemResourceSource.ItemResourceRow> rows = new ArrayList<>();
        List<ClientIconRenderQueue.IconRequest> misses = new ArrayList<>();

        for (ItemRegistrySource.ItemRow item : items) {
            Path cachePath = cache.pathFor(item);
            if (Files.isRegularFile(cachePath)) {
                try {
                    rows.add(rowFor(item.itemId(), cache.read(cachePath)));
                    continue;
                } catch (Exception exception) {
                    LOGGER.debug("忽略损坏的物品图标缓存 {} ({})", cachePath, item.itemId(), exception);
                }
            }

            ItemStack stack = stackFor(item.itemId());
            if (stack.isEmpty()) {
                LOGGER.debug("跳过物品 {} 的客户端贴图渲染：无法创建默认 ItemStack", item.itemId());
                continue;
            }
            misses.add(new ClientIconRenderQueue.IconRequest(item.itemId(), stack, cachePath));
        }

        if (!misses.isEmpty()) {
            progress.accept("客户端渲染物品贴图 " + misses.size() + " 个…");
            List<ClientIconRenderQueue.IconResult> rendered = ClientIconRenderQueue.submit(misses)
                .get(RENDER_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            progress.accept("客户端物品贴图渲染完成 " + rendered.size() + "/" + misses.size() + " 个");
            for (ClientIconRenderQueue.IconResult result : rendered) {
                try {
                    cache.write(result.cachePath(), result.png());
                } catch (Exception exception) {
                    LOGGER.debug("写入物品图标缓存失败 {} ({})", result.cachePath(), result.itemId(), exception);
                }
                rows.add(rowFor(result.itemId(), result.png()));
            }
        }

        return rows.stream()
            .sorted(Comparator.comparing(ItemResourceSource.ItemResourceRow::itemId))
            .toList();
    }

    private static ItemResourceSource.ItemResourceRow rowFor(String itemId, byte[] png) {
        return new ItemResourceSource.ItemResourceRow(
            itemId,
            RESOURCE_TYPE_TEXTURE,
            RENDERED_NAMESPACE,
            "rendered/item/" + itemId.replace(':', '/') + ".png",
            Base64.getEncoder().encodeToString(png)
        );
    }

    private static ItemStack stackFor(String itemId) {
        ResourceLocation id;
        try {
            id = ResourceLocation.parse(itemId);
        } catch (RuntimeException exception) {
            return ItemStack.EMPTY;
        }

        Item item = BuiltInRegistries.ITEM.get(id);
        if (item == Items.AIR) {
            return ItemStack.EMPTY;
        }
        ItemStack stack = item.getDefaultInstance();
        return stack.isEmpty() ? new ItemStack(item) : stack;
    }

    private static String resourcePackSignature(Minecraft minecraft) {
        try {
            return minecraft.getResourcePackRepository().getSelectedPacks().stream()
                .flatMap(Pack::streamSelfAndChildren)
                .map(Pack::getId)
                .sorted()
                .reduce((left, right) -> left + "\n" + right)
                .orElse("");
        } catch (Exception exception) {
            LOGGER.debug("读取客户端资源包签名失败", exception);
            return "unknown";
        }
    }
}
