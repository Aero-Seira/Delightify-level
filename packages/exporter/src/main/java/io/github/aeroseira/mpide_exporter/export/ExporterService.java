package io.github.aeroseira.dl_exporter.export;

import com.mojang.logging.LogUtils;
import io.github.aeroseira.dl_exporter.ModpackIdeExporter;
import io.github.aeroseira.dl_exporter.db.SqliteDatabase;
import io.github.aeroseira.dl_exporter.source.ItemResourceCapture;
import io.github.aeroseira.dl_exporter.source.ItemRegistrySource;
import io.github.aeroseira.dl_exporter.source.ItemResourceSource;
import io.github.aeroseira.dl_exporter.source.ItemTagSource;
import io.github.aeroseira.dl_exporter.source.LootTableSource;
import io.github.aeroseira.dl_exporter.source.ModListSource;
import io.github.aeroseira.dl_exporter.source.RecipeSource;
import io.github.aeroseira.dl_exporter.source.TranslationSource;
import net.minecraft.server.MinecraftServer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.ModList;
import net.neoforged.fml.loading.FMLEnvironment;
import org.slf4j.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * 导出编排（契约 §1 性能架构）。
 *
 * 关键纪律：<b>绝不在主线程做重活</b>。
 *  - 仅在 server thread 做<em>最小、快速的状态快照</em>（读注册表/RecipeManager/已解析 tag），尽快交还主线程。
 *  - 序列化（JSON/组件编码）+ SQLite 写入全部在后台 worker 线程。
 *  - 贴图渲染（客户端）走帧预算 + 复用 FBO + PBO 异步回读（见 client 包，待实现）。
 *  - 写临时文件，完成后原子改名。
 */
public final class ExporterService {

    private static final Logger LOGGER = LogUtils.getLogger();
    private static final ExporterService INSTANCE = new ExporterService();
    public static ExporterService get() { return INSTANCE; }

    private static final String OUTPUT_DIR = "dl-exporter";
    private static final String OUTPUT_FILE = "export.sqlite";
    private static final String EXPORTER_VERSION = "0.1.0";

    private final AtomicBoolean running = new AtomicBoolean(false);

    private ExporterService() {}

    /** 触发异步导出。立即返回，不阻塞调用线程（命令/主线程）。 */
    public void startAsync(MinecraftServer server, Consumer<String> progress) {
        if (!running.compareAndSet(false, true)) {
            progress.accept("已有导出在进行中，忽略本次请求");
            return;
        }
        Thread worker = new Thread(() -> {
            try {
                runExport(server, progress);
            } catch (Throwable t) {
                LOGGER.error("[{}] export failed", ModpackIdeExporter.MOD_ID, t);
                progress.accept("导出失败: " + t.getMessage());
            } finally {
                running.set(false);
            }
        }, "dl-export-worker");
        worker.setDaemon(true);
        worker.start();
    }

    private void runExport(MinecraftServer server, Consumer<String> progress) throws Exception {
        long t0 = System.currentTimeMillis();

        Path serverDir = server.getServerDirectory();
        Path outDir = serverDir.resolve(OUTPUT_DIR);
        Files.createDirectories(outDir);
        Path tmp = outDir.resolve(OUTPUT_FILE + ".tmp");
        Path finalPath = outDir.resolve(OUTPUT_FILE);
        Files.deleteIfExists(tmp);
        deleteSqliteSidecars(tmp);

        // ── 阶段 1：server thread 快照（最小、快速）────────────────────
        progress.accept("快照游戏状态…");
        Snapshot snapshot = onServerThread(server, () -> {
            ItemRegistrySource.Snapshot itemRegistry = ItemRegistrySource.capture(server);
            return new Snapshot(
                captureManifest(server),
                ModListSource.capture(),
                itemRegistry,
                ItemTagSource.capture(server),
                RecipeSource.capture(server),
                LootTableSource.capture(server)
            );
        });
        // TODO(契约 §7): recipe_views。
        //   各 source 见 source/ 包，逐表对照 docs/exporter-contract-v1.md。

        // ── 阶段 2：worker 线程序列化 + 写库 ──────────────────────────
        progress.accept("序列化配方…");
        RecipeSource.Rows recipes = RecipeSource.materialize(snapshot.recipes());
        ItemRegistrySource.Rows itemRegistryRows = ItemRegistrySource.materialize(snapshot.itemRegistry());

        progress.accept("序列化战利品表…");
        LootTableSource.Rows lootTables = LootTableSource.materialize(snapshot.lootTables());

        progress.accept("读取语言资源…");
        List<TranslationSource.TranslationRow> translations = TranslationSource.capture(server);

        progress.accept("导出物品贴图…");
        List<ItemResourceSource.ItemResourceRow> itemResources = ItemResourceCapture.capture(
            server,
            itemRegistryRows.items(),
            outDir,
            snapshot.manifest(),
            progress
        );

        progress.accept("写入数据库…");
        try (SqliteDatabase db = new SqliteDatabase(tmp)) {
            db.initializeSchema();
            db.writeManifest(snapshot.manifest());
            db.writeMods(snapshot.mods());
            db.writeItemRegistry(itemRegistryRows);
            db.writeItemTags(snapshot.itemTags());
            db.writeLootTables(lootTables);
            db.writeRecipes(recipes);
            db.writeTranslations(translations);
            db.writeItemResources(itemResources);
            // TODO: writeRecipeViews(...)
        }
        deleteSqliteSidecars(tmp);

        // ── 完成：原子改名 ───────────────────────────────────────────
        Files.move(tmp, finalPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        long ms = System.currentTimeMillis() - t0;
        LOGGER.info("[{}] export -> {} in {}ms", ModpackIdeExporter.MOD_ID, finalPath, ms);
        progress.accept("导出完成: " + finalPath.getFileName() + "（" + ms + "ms）");
    }

    /** manifest 采集（契约 §2）。轻量，安全地在 server thread 执行。 */
    private static Map<String, String> captureManifest(MinecraftServer server) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("schema_version", String.valueOf(io.github.aeroseira.dl_exporter.db.Schema.SCHEMA_VERSION));
        m.put("exporter_version", EXPORTER_VERSION);
        m.put("loader", "neoforge");
        m.put("mc_version", server.getServerVersion());
        m.put("neo_version", ModList.get().getModContainerById("neoforge")
            .map(c -> c.getModInfo().getVersion().toString()).orElse("unknown"));
        m.put("environment", FMLEnvironment.dist == Dist.CLIENT ? "integrated" : "dedicated");
        m.put("exported_at_utc", DateTimeFormatter.ISO_INSTANT.format(Instant.now()));
        m.put("world_name", server.getWorldData().getLevelName());
        m.put("modlist_hash", computeModlistHash());
        return m;
    }

    /** 真实 modlist 哈希（排序后的 modid:version 做 SHA-256），用于快照新鲜度比对。 */
    private static String computeModlistHash() {
        try {
            List<String> entries = ModList.get().getMods().stream()
                .map(mi -> mi.getModId() + ":" + mi.getVersion())
                .sorted()
                .toList();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(String.join("\n", entries).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** 把读操作调度到 server thread 执行并同步取回（worker 线程调用）。 */
    private static <T> T onServerThread(MinecraftServer server, Supplier<T> fn) throws Exception {
        if (server.isSameThread()) return fn.get();
        CompletableFuture<T> cf = new CompletableFuture<>();
        server.execute(() -> {
            try { cf.complete(fn.get()); }
            catch (Throwable t) { cf.completeExceptionally(t); }
        });
        return cf.get();
    }

    private static void deleteSqliteSidecars(Path dbPath) throws IOException {
        Files.deleteIfExists(dbPath.resolveSibling(dbPath.getFileName() + "-wal"));
        Files.deleteIfExists(dbPath.resolveSibling(dbPath.getFileName() + "-shm"));
    }

    private record Snapshot(
        Map<String, String> manifest,
        List<ModListSource.ModRow> mods,
        ItemRegistrySource.Snapshot itemRegistry,
        List<ItemTagSource.ItemTagRow> itemTags,
        RecipeSource.Snapshot recipes,
        LootTableSource.Snapshot lootTables
    ) {}
}
