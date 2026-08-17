# 导出快照契约

游戏内 exporter 写出 SQLite。`schema_version` 当前为 **3**。改表必须同步 `packages/exporter` 的 `Schema` 与 `packages/core` 的 importer，并升高版本号。

命令：`/dl_export dump`  
文件：`<实例>/dl-exporter/export.sqlite`

## manifest

```sql
schema_version(version INTEGER PRIMARY KEY)
manifest(key TEXT PRIMARY KEY, value TEXT NOT NULL)
```

必备键：`schema_version`、`exporter_version`、`loader`（`neoforge` | `forge` | `fabric`）、`mc_version`、`environment`（`integrated` | `dedicated`）、`exported_at_utc`、`world_name`、`modlist_hash`。

## 注册表

```sql
mods(modid TEXT PRIMARY KEY, version TEXT, name TEXT)

items(
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
)

item_creative_tabs(item_id TEXT NOT NULL, tab_id TEXT NOT NULL,
  PRIMARY KEY(item_id, tab_id))

blocks(
  block_id TEXT PRIMARY KEY,
  item_id TEXT,
  hardness REAL, resistance REAL,
  light_emission INTEGER,
  requires_correct_tool INTEGER,
  sound_type TEXT
)

item_tags(tag_id TEXT NOT NULL, item_id TEXT NOT NULL,
  PRIMARY KEY(tag_id, item_id))
```

`default_components_json` 是 1.21 DataComponentMap 的规范 JSON，为组件真相源。`items` 上的食物/耐久等列是同一份数据的投影，便于过滤。

## 配方

```sql
recipes(
  recipe_id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  modid TEXT NOT NULL,
  hash TEXT NOT NULL,
  raw_json TEXT,
  unparsed INTEGER NOT NULL,
  group TEXT,
  input_width INTEGER,
  input_height INTEGER
)

recipe_inputs(
  recipe_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  role TEXT NOT NULL,          -- input | catalyst
  kind TEXT NOT NULL,          -- item | tag | custom
  ref TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(recipe_id, slot, role, kind, ref)
)

recipe_outputs(
  recipe_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  components_json TEXT,
  is_primary INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(recipe_id, slot, item_id)
)
```

- `unparsed = 1` 时只有 `recipes` 行和 `raw_json`，没有结构化槽位。
- 有序合成：`input_width` / `input_height` 有值；`slot` 为行主序（`row × width + col`）。仅 `ShapedRecipe`（含模组子类）填写宽高。

## 翻译

```sql
translations(
  key TEXT NOT NULL,
  lang TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(key, lang)
)
```

显示名：`item.translation_key` → `translations`。

## 资源

```sql
item_resources(item_id, resource_type, namespace, path, content,
  PRIMARY KEY(item_id, resource_type, namespace, path))
recipe_views(type_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, base64_png TEXT, version INTEGER)
recipe_view_backgrounds(type_id TEXT PRIMARY KEY, png BLOB NOT NULL, sha1 TEXT NOT NULL)
```

`resource_type` 包括 texture、texture_path、model、model_path、blockstate 等。优先导出路径，贴图像素仅在无法离线重建时写入。

## 战利品

```sql
loot_tables(loot_table_id TEXT PRIMARY KEY, json TEXT NOT NULL)
loot_bindings(
  kind TEXT NOT NULL,          -- block | entity
  source_id TEXT NOT NULL,
  loot_table_id TEXT NOT NULL,
  PRIMARY KEY(kind, source_id)
)
```

绑定只保留注册表里真实存在的表，不含 `minecraft:empty`。导入时派生 `item_loot_sources`（物品 → 获取来源）。NeoForge Global Loot Modifier 不在本契约内。

## 导入后派生（在 project.db，不在快照里）

- `item_loot_sources`：由 loot 表递归展开。
- `graph_nodes` / `graph_edges`：物品、tag、配方、获取来源。
- `item_embeddings` / `embedding_meta`：仅在显式 `embed build` 后存在。
