/**
 * 数据采集器（sources）—— 各表一类，从游戏最终态读出纯数据对象。
 *
 * 已实现（对照 docs/exporter-contract-v1.md）：
 *  - ModListSource        → mods
 *  - ItemRegistrySource   → items (+ 确定性事实/默认组件) + item_creative_tabs + blocks
 *  - ItemTagSource        → item_tags（已解析的最终成员）
 *  - RecipeSource         → recipes + recipe_inputs + recipe_outputs（结构化，组件化）
 *  - TranslationSource    → translations
 *  - LootTableSource      → loot_tables + loot_bindings（契约 v2，最终态战利品表 + 精确绑定）
 *  - ItemResourceCapture  → item_resources（客户端最终态渲染，服务端回退离线提取）
 *  - ItemResourceSource   → item_resources（离线贴图提取回退）
 *
 * 待实现：
 *  - RecipeViewSource     → recipe_views（客户端 / JEI，@OnlyIn(Dist.CLIENT)）
 *
 * 纪律：采集只在 server thread 做最小快照；可浅引用已冻结/不可变的注册表上下文，
 * 但 JSON 编码等序列化与写库在 worker 线程（见 export.ExporterService）。
 */
package io.github.aeroseira.mpide_exporter.source;
