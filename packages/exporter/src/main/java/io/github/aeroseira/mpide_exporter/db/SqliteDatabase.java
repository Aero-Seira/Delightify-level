package io.github.aeroseira.mpide_exporter.db;

import com.mojang.logging.LogUtils;
import io.github.aeroseira.mpide_exporter.source.ItemRegistrySource;
import io.github.aeroseira.mpide_exporter.source.ItemResourceSource;
import io.github.aeroseira.mpide_exporter.source.ItemTagSource;
import io.github.aeroseira.mpide_exporter.source.LootTableSource;
import io.github.aeroseira.mpide_exporter.source.ModListSource;
import io.github.aeroseira.mpide_exporter.source.RecipeSource;
import io.github.aeroseira.mpide_exporter.source.TranslationSource;
import org.slf4j.Logger;

import java.nio.file.Path;
import java.sql.*;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * SQLite 写入封装。
 *
 * 性能要点（契约 §1）：开 WAL、synchronous=NORMAL、加大 cache、temp_store=MEMORY；
 * 所有批量写入走单事务 + addBatch。写入应在后台 worker 线程进行（见 ExporterService）。
 *
 * 类加载兼容：NeoForge 模块化 ClassLoader 默认看不到 JDBC 驱动（ServiceLoader 失效），
 * 故显式多 ClassLoader 加载 org.sqlite.JDBC 并用 DriverWrapper 注册（沿用旧 exporter 的已验证做法）。
 * 前提：sqlite-jdbc 通过 jarJar 打进 mod jar（见 build.gradle）。
 */
public final class SqliteDatabase implements AutoCloseable {

    private static final Logger LOGGER = LogUtils.getLogger();
    private final Connection connection;

    public SqliteDatabase(Path dbPath) throws SQLException {
        Class<?> driverClass = loadDriverClass();
        if (driverClass == null) {
            throw new SQLException("SQLite JDBC 驱动未找到。确认 sqlite-jdbc 已通过 jarJar 打包。");
        }
        try {
            Driver driver = (Driver) driverClass.getDeclaredConstructor().newInstance();
            DriverManager.registerDriver(new DriverWrapper(driver));
        } catch (Exception e) {
            throw new SQLException("实例化 SQLite JDBC 驱动失败", e);
        }

        dbPath.getParent().toFile().mkdirs();
        this.connection = DriverManager.getConnection("jdbc:sqlite:" + dbPath.toAbsolutePath());

        try (Statement st = connection.createStatement()) {
            st.execute("PRAGMA journal_mode = WAL");
            st.execute("PRAGMA synchronous = NORMAL");
            st.execute("PRAGMA temp_store = MEMORY");
            st.execute("PRAGMA cache_size = -20000"); // ~20MB
        }
    }

    /** 建表 + 写入 schema_version。 */
    public void initializeSchema() throws SQLException {
        try (Statement st = connection.createStatement()) {
            for (String ddl : Schema.ddl()) {
                st.execute(ddl);
            }
        }
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_SCHEMA_VERSION)) {
            ps.setInt(1, Schema.SCHEMA_VERSION);
            ps.executeUpdate();
        }
        LOGGER.info("schema initialized (v{})", Schema.SCHEMA_VERSION);
    }

    /** 单事务写入 manifest（key-value）。 */
    public void writeManifest(Map<String, String> entries) throws SQLException {
        inTransaction(() -> {
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_MANIFEST)) {
                for (Map.Entry<String, String> e : entries.entrySet()) {
                    if (e.getValue() == null) continue;
                    ps.setString(1, e.getKey());
                    ps.setString(2, e.getValue());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        });
    }

    public void writeMods(List<ModListSource.ModRow> rows) throws SQLException {
        inTransaction(() -> {
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_MOD)) {
                for (ModListSource.ModRow row : rows) {
                    ps.setString(1, row.modid());
                    ps.setString(2, row.version());
                    ps.setString(3, row.name());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        });
    }

    public void writeItemRegistry(ItemRegistrySource.Rows snapshot) throws SQLException {
        inTransaction(() -> {
            writeItems(snapshot.items());
            writeItemCreativeTabs(snapshot.creativeTabs());
            writeBlocks(snapshot.blocks());
        });
    }

    private void writeItems(List<ItemRegistrySource.ItemRow> rows) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_ITEM)) {
            for (ItemRegistrySource.ItemRow row : rows) {
                ps.setString(1, row.itemId());
                ps.setString(2, row.modid());
                ps.setString(3, row.translationKey());
                ps.setInt(4, boolInt(row.block()));
                ps.setInt(5, row.maxStack());
                ps.setInt(6, row.maxDamage());
                ps.setInt(7, boolInt(row.damageable()));
                ps.setInt(8, boolInt(row.fireResistant()));
                ps.setString(9, row.rarity());
                ps.setInt(10, row.enchantValue());
                setNullableInt(ps, 11, row.foodNutrition());
                setNullableDouble(ps, 12, row.foodSaturation());
                setNullableInt(ps, 13, row.foodAlwaysEat());
                ps.setString(14, row.defaultComponentsJson());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    public void writeItemTags(List<ItemTagSource.ItemTagRow> rows) throws SQLException {
        inTransaction(() -> {
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_ITEM_TAG)) {
                for (ItemTagSource.ItemTagRow row : rows) {
                    ps.setString(1, row.tagId());
                    ps.setString(2, row.itemId());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        });
    }

    public void writeLootTables(LootTableSource.Rows rows) throws SQLException {
        inTransaction(() -> {
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_LOOT_TABLE)) {
                for (LootTableSource.LootTableRow row : rows.tables()) {
                    ps.setString(1, row.lootTableId());
                    ps.setString(2, row.json());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_LOOT_BINDING)) {
                for (LootTableSource.BindingRow row : rows.bindings()) {
                    ps.setString(1, row.kind());
                    ps.setString(2, row.sourceId());
                    ps.setString(3, row.lootTableId());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        });
    }

    public void writeTranslations(List<TranslationSource.TranslationRow> rows) throws SQLException {
        inTransaction(() -> {
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_TRANSLATION)) {
                for (TranslationSource.TranslationRow row : rows) {
                    ps.setString(1, row.key());
                    ps.setString(2, row.lang());
                    ps.setString(3, row.value());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        });
    }

    public void writeItemResources(List<ItemResourceSource.ItemResourceRow> rows) throws SQLException {
        inTransaction(() -> {
            try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_ITEM_RESOURCE)) {
                for (ItemResourceSource.ItemResourceRow row : rows) {
                    ps.setString(1, row.itemId());
                    ps.setString(2, row.resourceType());
                    ps.setString(3, row.namespace());
                    ps.setString(4, row.path());
                    ps.setString(5, row.content());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        });
    }

    public void writeRecipes(RecipeSource.Rows rows) throws SQLException {
        inTransaction(() -> {
            writeRecipeRows(rows.recipes());
            writeRecipeInputs(rows.inputs());
            writeRecipeOutputs(rows.outputs());
        });
    }

    private void writeRecipeRows(List<RecipeSource.RecipeRow> rows) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_RECIPE)) {
            for (RecipeSource.RecipeRow row : rows) {
                ps.setString(1, row.recipeId());
                ps.setString(2, row.typeId());
                ps.setString(3, row.modid());
                ps.setString(4, row.hash());
                ps.setString(5, row.rawJson());
                ps.setInt(6, boolInt(row.unparsed()));
                ps.setString(7, row.group());
                setNullableInt(ps, 8, row.inputWidth());
                setNullableInt(ps, 9, row.inputHeight());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void writeRecipeInputs(List<RecipeSource.RecipeInputRow> rows) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_RECIPE_INPUT)) {
            for (RecipeSource.RecipeInputRow row : rows) {
                ps.setString(1, row.recipeId());
                ps.setInt(2, row.slot());
                ps.setString(3, row.role());
                ps.setString(4, row.kind());
                ps.setString(5, row.ref());
                ps.setInt(6, row.count());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void writeRecipeOutputs(List<RecipeSource.RecipeOutputRow> rows) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_RECIPE_OUTPUT)) {
            for (RecipeSource.RecipeOutputRow row : rows) {
                ps.setString(1, row.recipeId());
                ps.setInt(2, row.slot());
                ps.setString(3, row.itemId());
                ps.setInt(4, row.count());
                ps.setString(5, row.componentsJson());
                ps.setInt(6, boolInt(row.primary()));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void writeItemCreativeTabs(List<ItemRegistrySource.ItemCreativeTabRow> rows) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_ITEM_CREATIVE_TAB)) {
            for (ItemRegistrySource.ItemCreativeTabRow row : rows) {
                ps.setString(1, row.itemId());
                ps.setString(2, row.tabId());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void writeBlocks(List<ItemRegistrySource.BlockRow> rows) throws SQLException {
        try (PreparedStatement ps = connection.prepareStatement(Schema.UPSERT_BLOCK)) {
            for (ItemRegistrySource.BlockRow row : rows) {
                ps.setString(1, row.blockId());
                ps.setString(2, row.itemId());
                setNullableDouble(ps, 3, row.hardness());
                setNullableDouble(ps, 4, row.resistance());
                setNullableInt(ps, 5, row.lightEmission());
                setNullableInt(ps, 6, row.requiresCorrectTool() == null ? null : boolInt(row.requiresCorrectTool()));
                ps.setString(7, row.soundType());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void inTransaction(SqlRunnable body) throws SQLException {
        connection.setAutoCommit(false);
        try {
            body.run();
            connection.commit();
        } catch (SQLException ex) {
            connection.rollback();
            throw ex;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    private static void setNullableInt(PreparedStatement ps, int index, Integer value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.INTEGER);
        } else {
            ps.setInt(index, value);
        }
    }

    private static void setNullableDouble(PreparedStatement ps, int index, Double value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.REAL);
        } else {
            ps.setDouble(index, value);
        }
    }

    private static int boolInt(boolean value) {
        return value ? 1 : 0;
    }

    public Connection connection() {
        return connection;
    }

    @Override
    public void close() throws SQLException {
        if (connection != null && !connection.isClosed()) {
            try (Statement st = connection.createStatement()) {
                st.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            }
            connection.close();
        }
    }

    @FunctionalInterface
    private interface SqlRunnable {
        void run() throws SQLException;
    }

    // ── JDBC 驱动加载兜底 ──────────────────────────────────────────
    private static Class<?> loadDriverClass() {
        final String name = "org.sqlite.JDBC";
        ClassLoader[] candidates = {
            Thread.currentThread().getContextClassLoader(),
            SqliteDatabase.class.getClassLoader(),
            ClassLoader.getSystemClassLoader(),
        };
        for (ClassLoader cl : candidates) {
            if (cl == null) continue;
            try {
                return Class.forName(name, true, cl);
            } catch (ClassNotFoundException ignored) {
                // 试下一个
            }
        }
        try {
            return Class.forName(name);
        } catch (ClassNotFoundException e) {
            LOGGER.error("所有 ClassLoader 均未能加载 {}", name);
            return null;
        }
    }

    /** 委托包装，绕过 NeoForge 模块化 ClassLoader 对 DriverManager 的限制。 */
    private record DriverWrapper(Driver delegate) implements Driver {
        @Override public Connection connect(String url, Properties info) throws SQLException { return delegate.connect(url, info); }
        @Override public boolean acceptsURL(String url) throws SQLException { return delegate.acceptsURL(url); }
        @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException { return delegate.getPropertyInfo(url, info); }
        @Override public int getMajorVersion() { return delegate.getMajorVersion(); }
        @Override public int getMinorVersion() { return delegate.getMinorVersion(); }
        @Override public boolean jdbcCompliant() { return delegate.jdbcCompliant(); }
        @Override public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getLogger("mpide-sqlite"); }
    }
}
