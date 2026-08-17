package io.github.aeroseira.dl_exporter.command;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.context.CommandContext;
import io.github.aeroseira.dl_exporter.export.ExporterService;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.RegisterCommandsEvent;

/**
 * 命令：{@code /dl_export dump} —— 触发异步导出。
 *
 * 固定契约（不随实现变更）：命令名 dl_export、子命令 dump、
 * 输出 {@code <serverDir>/dl_exporter/export.sqlite}（见 ExporterService）。
 */
public final class ExportCommand {

    private ExportCommand() {}

    @SubscribeEvent
    public static void onRegisterCommands(RegisterCommandsEvent event) {
        register(event.getDispatcher());
    }

    private static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(
            Commands.literal("dl_export")
                .requires(src -> src.hasPermission(2))
                .then(Commands.literal("dump").executes(ExportCommand::runDump))
        );
    }

    private static int runDump(CommandContext<CommandSourceStack> ctx) {
        CommandSourceStack src = ctx.getSource();
        MinecraftServer server = src.getServer();
        src.sendSuccess(() -> Component.literal("[DL] 开始异步导出…"), true);

        // 进度回报切回 server thread 再发消息（聊天 API 非线程安全）。
        ExporterService.get().startAsync(server, msg ->
            server.execute(() -> src.sendSystemMessage(Component.literal("[DL] " + msg)))
        );
        return Command.SINGLE_SUCCESS;
    }
}
