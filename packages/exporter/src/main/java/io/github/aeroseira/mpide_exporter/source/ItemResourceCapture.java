package io.github.aeroseira.mpide_exporter.source;

import com.mojang.logging.LogUtils;
import net.minecraft.server.MinecraftServer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.loading.FMLEnvironment;
import org.slf4j.Logger;

import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** 物品贴图采集入口：客户端用最终态渲染，服务端退回离线资源提取。 */
public final class ItemResourceCapture {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final String CLIENT_BRIDGE =
        "io.github.aeroseira.mpide_exporter.client.ClientItemIconExportBridge";

    private ItemResourceCapture() {}

    public static List<ItemResourceSource.ItemResourceRow> capture(
        MinecraftServer server,
        List<ItemRegistrySource.ItemRow> items,
        Path exportDir,
        Map<String, String> manifest,
        Consumer<String> progress
    ) {
        if (FMLEnvironment.dist == Dist.CLIENT) {
            try {
                return captureWithClientRenderer(server, items, exportDir, manifest, progress);
            } catch (Exception exception) {
                LOGGER.warn("客户端最终态物品贴图导出失败，回退到离线贴图提取", exception);
                progress.accept("客户端物品贴图渲染失败，回退到离线提取…");
            }
        }

        return ItemResourceSource.capture(server);
    }

    @SuppressWarnings("unchecked")
    private static List<ItemResourceSource.ItemResourceRow> captureWithClientRenderer(
        MinecraftServer server,
        List<ItemRegistrySource.ItemRow> items,
        Path exportDir,
        Map<String, String> manifest,
        Consumer<String> progress
    ) throws Exception {
        Class<?> bridgeClass = Class.forName(CLIENT_BRIDGE);
        Method capture = bridgeClass.getMethod(
            "capture",
            MinecraftServer.class,
            List.class,
            Path.class,
            Map.class,
            Consumer.class
        );
        return (List<ItemResourceSource.ItemResourceRow>) capture.invoke(
            null,
            server,
            items,
            exportDir,
            manifest,
            progress
        );
    }
}
