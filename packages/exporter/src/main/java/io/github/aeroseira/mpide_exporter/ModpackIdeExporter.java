package io.github.aeroseira.mpide_exporter;

import com.mojang.logging.LogUtils;
import io.github.aeroseira.mpide_exporter.command.ExportCommand;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;

/**
 * ModPack IDE Exporter —— 主入口（NeoForge 1.21.1）。
 *
 * 职责：注册 /mpide_export 命令。导出逻辑见 {@link io.github.aeroseira.mpide_exporter.export.ExporterService}。
 * 契约见仓库外 docs/exporter-contract-v1.md（ModPack IDE 主仓）。
 */
@Mod(ModpackIdeExporter.MOD_ID)
public final class ModpackIdeExporter {

    public static final String MOD_ID = "mpide_exporter";
    public static final Logger LOGGER = LogUtils.getLogger();

    public ModpackIdeExporter(IEventBus modEventBus, ModContainer modContainer) {
        // 命令注册是游戏事件（非 mod 加载事件），走 NeoForge.EVENT_BUS。
        NeoForge.EVENT_BUS.register(ExportCommand.class);
        LOGGER.info("[{}] initialized (NeoForge exporter)", MOD_ID);
    }
}
