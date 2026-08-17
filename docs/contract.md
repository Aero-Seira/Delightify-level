# Exporter 契约（当前 v3）

> Delightify 世界库 ↔ 游戏内 Exporter 的接口。**契约先行**。
> 从 Delightify-IDE 迁入时重写了抬头；表结构未改。
> 版本：v3（含战利品表与配方网格宽高）。v2 起有 `loot_tables` / `loot_bindings`。

## 0. 决策摘要（已拍板）

- 目标平台：**1.21.1 NeoForge 优先**；采集逻辑与版本/平台解耦（差异收敛进 `manifest` + 注入参数），为将来重接 1.20.1 留接口。
- exporter 是 `data:*` 事实的**权威来源**；离线 JAR 解析降级为预览/差集/资源提取的辅助层。
- **性能是首要目标**（见 §1）。
- 工作路径：本仓 `packages/exporter`。

---

## 1. 性能要求（首要，非功能性硬指标）

### 现 exporter 卡顿根因（已核对源码）
1. **`ExporterService.dump` 全程跑在服务端主线程**：采集 + 全部 SQLite 写入同步阻塞 tick → 大整合包卡死数秒。← 首要。
2. **逐物品建/毁 FBO + 同步 `glReadPixels`**（`ItemRenderHelper`）：每物品一次 GPU→CPU 回读强制管线 flush；像素遍历 + PNG 编码在渲染线程内联。
3. SQLite 写入（WAL+NORMAL+batch）基本合格，非主要瓶颈。

### 重写的性能架构（硬要求）
- **采集与写入必须离开主线程**。模型：
  - 在 server thread **快速快照**注册表/RecipeManager/已解析 tag（这些在已加载世界里实际不可变，浅引用即可），**尽快交还主线程**。
  - 序列化（JSON/组件编码）+ SQLite 写入放到**后台 worker 线程**。
  - 贴图渲染保持**帧预算**式（每帧限额），但底层改：**复用单个 FBO/纹理**、用 **PBO 异步回读**、像素转换与 PNG 编码丢到线程池。
- **贴图首选离线化**（最大性能杠杆）：exporter 主要导出**贴图文件引用/路径**（廉价），由 IDE 离线从 JAR 提取/合成 PNG；**仅对无法从文件重建的动态/BakedModel 物品**才在游戏内渲染兜底。
- 导出全程**异步 + 进度回报 + 不阻塞**；写临时文件，完成后原子改名。
- 验收：在 ~200 mod 整合包导出时，**单帧停顿不超过个位数毫秒级预算**，无可感卡顿。

---

## 2. 元信息（版本/平台解耦的关键）

```sql
schema_version(version INTEGER PRIMARY KEY)
manifest(key TEXT PRIMARY KEY, value TEXT NOT NULL)
```
`manifest` 必备 keys：
- `schema_version`, `exporter_version`
- `loader` — `'neoforge' | 'forge' | 'fabric'`（平台解耦）
- `mc_version` — 如 `'1.21.1'`（版本解耦）
- `environment` — `'integrated' | 'dedicated'`（决定有无贴图/视图）
- `exported_at_utc`, `world_name`
- `modlist_hash` — 真实哈希（**不是** mod 数量；现 exporter 用 mod_count 充数，要修）

> 所有版本/平台差异收敛进 manifest 一行；采集端把 `loader`/`mc_version` 当注入参数，逻辑不写死平台。IDE 据 `modlist_hash`+`exported_at` 判断快照新鲜度并提示重新导出。

---

## 3. 注册表事实（确定性事实尽量全面）

```sql
-- 模组
mods(modid TEXT PRIMARY KEY, version TEXT, name TEXT)

-- 物品（携带尽可能全的确定性事实）
items(
  item_id TEXT PRIMARY KEY,          -- namespace:path
  modid TEXT NOT NULL,
  translation_key TEXT,              -- 运行时真实 description id，如 item.minecraft.diamond
  is_block INTEGER NOT NULL,         -- 是否有对应方块
  max_stack INTEGER NOT NULL,
  max_damage INTEGER NOT NULL DEFAULT 0,   -- 0 = 不可损耗
  is_damageable INTEGER NOT NULL DEFAULT 0,
  is_fire_resistant INTEGER NOT NULL DEFAULT 0,
  rarity TEXT,                       -- common/uncommon/rare/epic
  enchant_value INTEGER DEFAULT 0,
  -- 食物（非食物为 NULL）
  food_nutrition INTEGER,
  food_saturation REAL,
  food_always_eat INTEGER,
  -- 完整默认组件（1.21 DataComponentMap），见 §5
  default_components_json TEXT
)

-- 创造模式标签页归属（many-to-many，用于 by_tab 选择器）
item_creative_tabs(item_id TEXT NOT NULL, tab_id TEXT NOT NULL,
  PRIMARY KEY(item_id, tab_id))

-- 方块专属事实（仅 is_block 物品；可分阶段填充）
blocks(
  block_id TEXT PRIMARY KEY,         -- = item_id（多数情况）
  item_id TEXT,
  hardness REAL, resistance REAL,
  light_emission INTEGER,
  requires_correct_tool INTEGER,
  sound_type TEXT
)

-- 已解析的最终 tag 成员
item_tags(tag_id TEXT NOT NULL, item_id TEXT NOT NULL,
  PRIMARY KEY(tag_id, item_id))
```

---

## 4. 配方（结构化 + 组件化，从第一天起）

```sql
recipes(
  recipe_id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  modid TEXT NOT NULL,
  hash TEXT NOT NULL,                -- 对结构化内容哈希，供增量对比
  raw_json TEXT,                     -- codec 序列化的完整配方（1.21 结构）
  unparsed INTEGER NOT NULL,         -- 1 = 未能结构化，仅保底
  group TEXT,
  input_width INTEGER,               -- v3+：有序合成网格宽（ShapedRecipe.pattern.width()），否则 NULL
  input_height INTEGER               -- v3+：有序合成网格高
)

recipe_inputs(
  recipe_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  role TEXT NOT NULL,                -- 'input' | 'catalyst'
  kind TEXT NOT NULL,                -- 'item' | 'tag' | 'custom'
  ref TEXT,                          -- item_id / tag_id；custom 时为 NULL（详情进 raw_json）
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(recipe_id, slot, role, kind, ref)
)

recipe_outputs(
  recipe_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  components_json TEXT,              -- 结果物品的组件补丁（见 §5）
  is_primary INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(recipe_id, slot, item_id)
)
```
- `recipe_inputs/outputs` 从第一天就建（旧 exporter 的 M2 一直 TODO，正是 IDE 被迫解析 raw_json 的根因）。
- unparsed 配方仍保底只写 `recipes` 行（含 raw_json）。
- **v3（schema_version 3）**：`recipes` 新增 `input_width` / `input_height` 可空列。`recipe_inputs.slot`
  对有序合成是**行主序**槽位（slot = row × input_width + col，空位跳过但仍占序号），
  此前契约不导出宽高，IDE 无法把槽位还原成二维网格；且代码构造（非 JSON 加载）的
  ShapedRecipe 无法被 codec 编码（raw_json 为 NULL），此时宽高 + 结构化槽位是唯一的布局依据。
  仅 `recipe instanceof ShapedRecipe` 时填写（含模组子类），其余配方为 NULL。

---

## 5. 物品组件表示（1.21 Data Components，推荐方案）

1.21 物品栈 = `item + count + DataComponentPatch`，NBT 已废弃。推荐：

- **完整性靠 JSON**：组件统一存为**用组件 Codec 针对 `RegistryAccess` 序列化出的规范 JSON**（`components_json` / `default_components_json`）。开放式、前向兼容、能容纳 mod 自定义组件。
- **查询性靠列**：常用确定性事实（max_damage/rarity/food…）**同时**抽成 `items` 的显式列（§3），快速过滤无需解析 JSON。
- 二者关系：显式列是 JSON 的投影，**JSON 为真相源**。
- 配方输出的非默认组件（附魔书、药水等）进 `recipe_outputs.components_json`。

---

## 6. 翻译（独立成表）

```sql
translations(
  key TEXT NOT NULL,                 -- 翻译键，如 item.minecraft.diamond / 物品/tag/配方类型通用
  lang TEXT NOT NULL,                -- 如 en_us / zh_cn
  value TEXT NOT NULL,
  PRIMARY KEY(key, lang)
)
```
- 取代旧的「lang 塞进 item_resources.lang_name」，覆盖物品 + tag + 配方类型显示名。
- IDE 侧按 `item → translation_key → translations` 解析显示名（用于语义辨识/rename/UI）。

---

## 7. 资源 / 视图（保留全部，修掉 importer 砍裁）

```sql
item_resources(item_id, resource_type, namespace, path, content,
  PRIMARY KEY(item_id, resource_type, namespace, path))
  -- resource_type 全保留: texture / texture_main / texture_path /
  --   model / model_path / blockstate ...（lang 移到 translations）
recipe_views(type_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, base64_png TEXT, version INTEGER)
recipe_view_backgrounds(type_id TEXT PRIMARY KEY, png BLOB NOT NULL, sha1 TEXT NOT NULL)
```
- 配合 §1 贴图离线化：`texture_path`/`model_path` 廉价导出供世界库离线提取；`texture`(Base64) 仅兜底渲染时写入。
- IDE importer **必须**读 `recipe_views`/`recipe_view_backgrounds`（旧 importer 完全没读，要修）。

---

## 8. 战利品表（契约 v2 新增，schema_version 2）

1.21 起战利品表是数据驱动注册表（`Registries.LOOT_TABLE`），运行时即最终态（vanilla + mods + datapack/KubeJS 覆盖）。exporter 只存**事实**：全量表的最终态 JSON + 精确的方块/实体绑定；「物品 → 获取来源」由 IDE 导入时派生物化（`mod-data-importer/loot-sources.ts`）。

```sql
loot_tables(
  loot_table_id TEXT PRIMARY KEY,   -- namespace:path
  json TEXT NOT NULL                -- LootTable.DIRECT_CODEC 针对 RegistryAccess 编码的完整表（1.21 结构）
)

loot_bindings(
  kind TEXT NOT NULL,               -- 'block' | 'entity'
  source_id TEXT NOT NULL,          -- 方块/实体注册 ID
  loot_table_id TEXT NOT NULL,
  PRIMARY KEY(kind, source_id)
)
```

- 绑定来自 `BlockBehaviour#getLootTable()` / `EntityType#getDefaultLootTable()`；二者返回路径约定 key（`blocks/<path>`、`entities/<path>`），表可能并不存在（如无掉落实体），故只保留注册表中真实存在的绑定，并剔除 `minecraft:empty`。
- IDE 派生规则：嵌套引用（`minecraft:loot_table` 条目，箱子战利品常用）记忆化递归 + 防环截断；`minecraft:tag` 按最终态 `item_tags` 展开；`empty`/`dynamic` 跳过；引用条目上的条件级联到被引用表产出；无绑定且未被引用的根表按路径约定分类（`chests/`、`gameplay/fishing*`、`archaeology/` 等）。
- 明确边界：NeoForge Global Loot Modifiers（GLM）在 roll 时叠加、不属于表本身，**不在**本契约范围；KubeJS 的改表操作发生在 reload 时，会被最终态注册表正常捕获。

---

## 9. IDE importer 侧需同步修正

1. 不再把 `item_resources` 过滤成只剩 texture+lang（保留全部类型）。
2. 读入 `recipe_views` / `recipe_view_backgrounds`。
3. 读入 `recipe_inputs` / `recipe_outputs` / `translations` / 新 `items` 列 / `item_creative_tabs` / `blocks`。
4. 事实带 provenance：标记来源为 `exporter@(modlist_hash, exported_at)`，与离线 JAR 来源区分信任级。

---

## 10. 待评审的开放点

- `blocks` 表字段是否够（要不要 tool tier、mining level、map color）？分阶段还是一次到位？
- `recipe_inputs.role` 除 input/catalyst 是否还需 'fluid'/'energy' 等（模组机器配方）？还是先靠 kind='custom'+raw_json 兜底。
- 贴图离线提取在 IDE 侧的可行性边界（多层/染色/BakedModel 的兜底比例）需做一次小样本验证。
- 新 repo 命名与位置。
