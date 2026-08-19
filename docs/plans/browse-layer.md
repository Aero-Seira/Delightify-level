# 实施计划：浏览层（本地图鉴）

浏览层的产品是「包里长什么样、我勾哪些 id」，不是已审核的边界。呈现层见 [`presentation-layer.md`](./presentation-layer.md)，两者产品独立。设计依据 [`../design.md`](../design.md) §3.1。

本文是实现契约。

## 1. 目标与非目标

**目标**

- **物品浏览**：图标 + id / 名 / tag 搜索，mod / tag 过滤，分面计数，分页。
- **配方浏览**：id / 输入 / 输出 / 类型 / mod 过滤，分面计数，分页。
- **配方画布**：`recipe_views` 有采集则按布局叠在底板上；没有则降级为结构化槽位网格（`input_width` × `input_height`）或平铺列表。
- **详情只读**：物品的 tag、战利品来源、`itemUsages`；配方的槽位。**不给任何「改这个」的入口。**
- **多选与导出**：勾选后复制 / 下载 ID 列表。
- 与呈现层同进程不同路由，共用 `present-serve.mjs` 与 `127.0.0.1`。

**非目标**

- 工作台、配方 / 物品编辑、写盘、应用内 agent、把选取送进 engine 动作。
- 不做 `agent-query` 的 `browse` 域：这是人用的过滤，不是 §4 的 agent 检索管线，不该被 agent 当成饱和结果用。
- 不把选取变成 scope。导出只出剪贴板 / 浏览器下载，没有 `saturated`。
- 不改快照 schema、不升 `schema_version`、不补 exporter 的 `RecipeViewSource`（画布的采集路径先写好读取端，等采集）。
- 不沿用 IDE 的 `config/recipe_types` 手写模板。

## 2. 从 Delightify-IDE 复用什么

| IDE 来源 | 复用 | 优化 |
|---|---|---|
| `ipc/items.ts` | 物品搜索 SQL（id / 翻译名 / tag 三路 + `en_us` 回退）、分面计数一次聚合 | 抽成 `browse/filters.ts` 的纯函数，count 与 query 共用一套条件（IDE 里是两份重复串） |
| `ipc/items.ts` `TAGS_QUERY` | tag 列表 | 改服务端搜索 + 上限；IDE 是全量灌进渲染层再前端过滤 |
| `ipc/recipes.ts` | 配方查询与分面 | 搜索默认走 `recipe_inputs` / `recipe_outputs` 索引，`raw_json LIKE` 降级为显式选项（IDE 默认全表扫 JSON） |
| `hooks/useTexture.ts` + `components/ItemIcon` | 缺图标时的稳定色 + 首字母占位 | 图标改**二进制 PNG 端点** + `immutable` 缓存 + `loading="lazy"`，浏览器自己缓存；IDE 是每个图标一次 JSON+base64 往返 |
| `components/RecipeCard` | 有序合成按 `input_width` × `input_height` 摆位、越界回退平铺 | 只留只读渲染，去掉编辑 / blast / 动作链接 |

不复用：工作台壳、ActivityBar、Knowledge Center、plans / agent / gate / intent 相关一切。

## 3. 后端：`packages/core/src/browse/`

纯查询，不建表、不写盘。

| 文件 | 内容 |
|---|---|
| `filters.ts` | 纯函数：`clampLimit`、`buildItemFilter`、`buildRecipeFilter`、`truncationOf` |
| `items.ts` | `browseItems` / `browseItemFacets` / `browseItemDetail` / `listMods` / `listTags` |
| `recipes.ts` | `browseRecipes` / `browseRecipeFacets` / `browseRecipeDetail` / `listRecipeTypes` |
| `views.ts` | `loadRecipeView`：读 `recipe_views` + `recipe_view_backgrounds`，形状不合就返回 `null` 走降级 |
| `icons.ts` | `loadItemIconPng`：`item_resources` 的 base64 → 字节 |

上限（不变量 4.4）：

- 分页端点 `pageSize` 默认 50、上限 200，回显 `page` / `pageSize` / `total`。
- 非分页集合（mods / tags / types / 详情里的 tags / usages / 分面）各有默认上限，超限填 `truncated: { returned, total, by }`。

顺带修 `graph/query.ts` 的 `itemUsages` 无上限（[`../../AGENT.md`](../../AGENT.md) §6 债务表第一条）：加 `limit`（默认 200）与 `truncated`，浏览层详情页直接消费它。

## 4. 配方视图 layout_json 的形状

`recipe_views` 现在没有数据（exporter 的 `RecipeViewSource` 是 TODO）。读取端先按下面的形状实现，采集端落地时对齐它；对不上就降级，不报错：

```json
{
  "width": 116,
  "height": 54,
  "slots": [
    { "role": "input",  "index": 0, "x": 0,  "y": 0,  "w": 18, "h": 18 },
    { "role": "output", "index": 0, "x": 94, "y": 18, "w": 26, "h": 26 }
  ]
}
```

- 坐标是相对底板左上角的像素，`w` / `h` 缺省 18。
- `role` ∈ `input` | `output` | `catalyst`；`index` 对应 `recipe_inputs.slot` / `recipe_outputs.slot`。
- `slots` 不是非空数组，或缺 `width` / `height` → 视为无布局。

降级顺序：JEI 布局 → `input_width` × `input_height` 结构化网格 → 平铺槽位列表。页面上明写用的是哪一种。

## 5. 路由

`scripts/present-serve.mjs` 同进程加：

```
GET /b                      浏览层页面（browse.html）
GET /b/i/<itemId>           物品详情直链
GET /b/r/<recipeId>         配方详情直链

GET /api/browse/items?q=&field=all|id|name|tag&mod=&tag=&page=&page-size=&lang=
GET /api/browse/items/facets?...      mod / tag 分面计数
GET /api/browse/item?id=              详情：tags、战利品来源、usages
GET /api/browse/recipes?q=&field=all|id|input|output|json&mod=&type=&page=&page-size=
GET /api/browse/recipes/facets?...    mod / type 分面计数
GET /api/browse/recipe?id=            详情：槽位 + 布局（或降级标记）
GET /api/browse/mods
GET /api/browse/tags?q=&limit=
GET /api/browse/recipe-types?q=&limit=

GET /icon/<itemId>.png                二进制图标，缺则 404
GET /recipe-bg/<typeId>.png           配方底板
```

`/icon` 与 `/recipe-bg` 带 `ETag` 与 `cache-control: public, max-age=31536000, immutable`——快照是静态的，换包要换项目库。

呈现层的成员列表也用 `/icon`，这是顺带的可读性收益。

## 6. 前端

`packages/present/static/` 加 `browse.html` / `browse.js`，与审核页共用 `style.css`。无构建、无框架。

- 两层各自一个页面，顶栏两个链接互跳。**不合成一个壳**：浏览页没有 scope 动作，审核页没有图鉴过滤。
- 物品：网格 / 列表两种视图，勾选进选集，选集常驻底栏，显示计数。
- 导出：复制 ID（换行）、复制 JSON 数组、下载 `.txt`、复制成 `scope create` 命令行（仍只进剪贴板，不写盘、不建 scope）。
- 详情：右侧抽屉，tags / 来源 / usages / 配方槽位，只读。

## 7. 验证

没有测试框架。手动：

1. `pnpm typecheck` 与 `pnpm build`。
2. `node scripts/present-serve.mjs <p>` → 开 `/b`，翻页、过滤、勾选、导出。
3. 无 `item_resources` 的库要能正常出占位图标；无 `recipe_views` 的库要走降级画布。
