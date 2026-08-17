package io.github.aeroseira.mpide_exporter.db;

import java.util.List;

/**
 * 导出库 schema —— 契约（v1 起，当前 v3；见 ModPack IDE 主仓 docs/exporter-contract-v1.md）。
 *
 * 这是 exporter ↔ IDE 的接口。改表 = 改契约：必须同步 IDE importer 并升 SCHEMA_VERSION。
 */
public final class Schema {

    /** 新契约从 1 起（与旧 Delightify v4 不兼容，是全新命名空间）。v2 新增 loot_tables / loot_bindings；v3 新增 recipes.input_width / input_height。 */
    public static final int SCHEMA_VERSION = 3;

    private Schema() {}

    /** 所有建表 + 索引 DDL，按依赖顺序。 */
    public static List<String> ddl() {
        return List.of(
            // ── 元信息 ────────────────────────────────────────────────
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
            "CREATE TABLE IF NOT EXISTS manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL)",

            // ── 注册表事实 ────────────────────────────────────────────
            "CREATE TABLE IF NOT EXISTS mods (modid TEXT PRIMARY KEY, version TEXT, name TEXT)",

            """
            CREATE TABLE IF NOT EXISTS items (
              item_id TEXT PRIMARY KEY,
              modid TEXT NOT NULL,
              translation_key TEXT,
              is_block INTEGER NOT NULL,
              max_stack INTEGER NOT NULL,
              max_damage INTEGER NOT NULL DEFAULT 0,
              is_damageable INTEGER NOT NULL DEFAULT 0,
              is_fire_resistant INTEGER NOT NULL DEFAULT 0,
              rarity TEXT,
              enchant_value INTEGER DEFAULT 0,
              food_nutrition INTEGER,
              food_saturation REAL,
              food_always_eat INTEGER,
              default_components_json TEXT
            )""",
            "CREATE INDEX IF NOT EXISTS idx_items_modid ON items(modid)",

            """
            CREATE TABLE IF NOT EXISTS item_creative_tabs (
              item_id TEXT NOT NULL,
              tab_id TEXT NOT NULL,
              PRIMARY KEY (item_id, tab_id)
            )""",

            """
            CREATE TABLE IF NOT EXISTS blocks (
              block_id TEXT PRIMARY KEY,
              item_id TEXT,
              hardness REAL,
              resistance REAL,
              light_emission INTEGER,
              requires_correct_tool INTEGER,
              sound_type TEXT
            )""",

            """
            CREATE TABLE IF NOT EXISTS item_tags (
              tag_id TEXT NOT NULL,
              item_id TEXT NOT NULL,
              PRIMARY KEY (tag_id, item_id)
            )""",
            "CREATE INDEX IF NOT EXISTS idx_item_tags_item_id ON item_tags(item_id)",

            // ── 战利品表（最终态 JSON + 精确绑定）────────────────────
            """
            CREATE TABLE IF NOT EXISTS loot_tables (
              loot_table_id TEXT PRIMARY KEY,
              json TEXT NOT NULL
            )""",

            """
            CREATE TABLE IF NOT EXISTS loot_bindings (
              kind TEXT NOT NULL,
              source_id TEXT NOT NULL,
              loot_table_id TEXT NOT NULL,
              PRIMARY KEY (kind, source_id)
            )""",
            "CREATE INDEX IF NOT EXISTS idx_loot_bindings_table ON loot_bindings(loot_table_id)",

            // ── 配方（结构化 + 组件化）────────────────────────────────
            """
            CREATE TABLE IF NOT EXISTS recipes (
              recipe_id TEXT PRIMARY KEY,
              type_id TEXT NOT NULL,
              modid TEXT NOT NULL,
              hash TEXT NOT NULL,
              raw_json TEXT,
              unparsed INTEGER NOT NULL,
              "group" TEXT,
              input_width INTEGER,
              input_height INTEGER
            )""",
            "CREATE INDEX IF NOT EXISTS idx_recipes_type_id ON recipes(type_id)",
            "CREATE INDEX IF NOT EXISTS idx_recipes_modid ON recipes(modid)",

            """
            CREATE TABLE IF NOT EXISTS recipe_inputs (
              recipe_id TEXT NOT NULL,
              slot INTEGER NOT NULL,
              role TEXT NOT NULL,
              kind TEXT NOT NULL,
              ref TEXT,
              count INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY (recipe_id, slot, role, kind, ref)
            )""",
            "CREATE INDEX IF NOT EXISTS idx_recipe_inputs_ref ON recipe_inputs(kind, ref)",
            "CREATE INDEX IF NOT EXISTS idx_recipe_inputs_recipe_id ON recipe_inputs(recipe_id)",

            """
            CREATE TABLE IF NOT EXISTS recipe_outputs (
              recipe_id TEXT NOT NULL,
              slot INTEGER NOT NULL,
              item_id TEXT NOT NULL,
              count INTEGER NOT NULL DEFAULT 1,
              components_json TEXT,
              is_primary INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY (recipe_id, slot, item_id)
            )""",
            "CREATE INDEX IF NOT EXISTS idx_recipe_outputs_item ON recipe_outputs(item_id)",

            // ── 翻译（独立成表）──────────────────────────────────────
            """
            CREATE TABLE IF NOT EXISTS translations (
              key TEXT NOT NULL,
              lang TEXT NOT NULL,
              value TEXT NOT NULL,
              PRIMARY KEY (key, lang)
            )""",

            // ── 资源 / 配方视图 ──────────────────────────────────────
            """
            CREATE TABLE IF NOT EXISTS item_resources (
              item_id TEXT NOT NULL,
              resource_type TEXT NOT NULL,
              namespace TEXT NOT NULL,
              path TEXT NOT NULL,
              content TEXT,
              PRIMARY KEY (item_id, resource_type, namespace, path)
            )""",
            "CREATE INDEX IF NOT EXISTS idx_item_resources_item_id ON item_resources(item_id)",

            """
            CREATE TABLE IF NOT EXISTS recipe_views (
              type_id TEXT PRIMARY KEY,
              layout_json TEXT NOT NULL,
              base64_png TEXT,
              version INTEGER NOT NULL DEFAULT 1
            )""",

            """
            CREATE TABLE IF NOT EXISTS recipe_view_backgrounds (
              type_id TEXT PRIMARY KEY,
              png BLOB NOT NULL,
              sha1 TEXT NOT NULL
            )"""
        );
    }

    public static final String UPSERT_SCHEMA_VERSION =
        "INSERT OR REPLACE INTO schema_version (version) VALUES (?)";
    public static final String UPSERT_MANIFEST =
        "INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)";
    public static final String UPSERT_MOD =
        "INSERT OR REPLACE INTO mods (modid, version, name) VALUES (?, ?, ?)";
    public static final String UPSERT_ITEM = """
        INSERT OR REPLACE INTO items (
          item_id, modid, translation_key, is_block, max_stack, max_damage,
          is_damageable, is_fire_resistant, rarity, enchant_value,
          food_nutrition, food_saturation, food_always_eat,
          default_components_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""";
    public static final String UPSERT_ITEM_CREATIVE_TAB =
        "INSERT OR REPLACE INTO item_creative_tabs (item_id, tab_id) VALUES (?, ?)";
    public static final String UPSERT_BLOCK = """
        INSERT OR REPLACE INTO blocks (
          block_id, item_id, hardness, resistance, light_emission,
          requires_correct_tool, sound_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?)""";
    public static final String UPSERT_ITEM_TAG =
        "INSERT OR REPLACE INTO item_tags (tag_id, item_id) VALUES (?, ?)";
    public static final String UPSERT_LOOT_TABLE =
        "INSERT OR REPLACE INTO loot_tables (loot_table_id, json) VALUES (?, ?)";
    public static final String UPSERT_LOOT_BINDING =
        "INSERT OR REPLACE INTO loot_bindings (kind, source_id, loot_table_id) VALUES (?, ?, ?)";
    public static final String UPSERT_TRANSLATION =
        "INSERT OR REPLACE INTO translations (key, lang, value) VALUES (?, ?, ?)";
    public static final String UPSERT_ITEM_RESOURCE =
        "INSERT OR REPLACE INTO item_resources (item_id, resource_type, namespace, path, content) VALUES (?, ?, ?, ?, ?)";
    public static final String UPSERT_RECIPE = """
        INSERT OR REPLACE INTO recipes (
          recipe_id, type_id, modid, hash, raw_json, unparsed, "group", input_width, input_height
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""";
    public static final String UPSERT_RECIPE_INPUT = """
        INSERT OR REPLACE INTO recipe_inputs (
          recipe_id, slot, role, kind, ref, count
        ) VALUES (?, ?, ?, ?, ?, ?)""";
    public static final String UPSERT_RECIPE_OUTPUT = """
        INSERT OR REPLACE INTO recipe_outputs (
          recipe_id, slot, item_id, count, components_json, is_primary
        ) VALUES (?, ?, ?, ?, ?, ?)""";
}
