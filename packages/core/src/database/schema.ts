/**
 * leveled Database Schema - v2.1
 * 
 * 根据 reference_sql/export.sqlite 样例调整的数据库设计
 * 与附属Mod生成的数据结构保持一致
 */

import { sqliteTable, text, integer, real, blob, primaryKey } from 'drizzle-orm/sqlite-core';

// ============================================================================
// 元数据表
// ============================================================================

/**
 * Schema 版本表
 */
export const schemaVersion = sqliteTable('schema_version', {
  version: integer('version').primaryKey(),
});

/**
 * 清单表 - 存储导出元数据
 */
export const manifest = sqliteTable('manifest', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ============================================================================
// 核心数据表（与附属Mod导出的结构一致）
// ============================================================================

/**
 * 模组信息表
 */
export const mods = sqliteTable('mods', {
  modid: text('modid').primaryKey(),
  version: text('version'),
  name: text('name'),
});

/**
 * 物品/方块表
 */
export const items = sqliteTable('items', {
  itemId: text('item_id').primaryKey(),
  modid: text('modid').notNull().references(() => mods.modid),
  translationKey: text('translation_key'),
  isBlock: integer('is_block', { mode: 'boolean' }).notNull().default(false),
  maxStack: integer('max_stack').notNull().default(64),
  maxDamage: integer('max_damage').notNull().default(0),
  isDamageable: integer('is_damageable', { mode: 'boolean' }).notNull().default(false),
  isFireResistant: integer('is_fire_resistant', { mode: 'boolean' }).notNull().default(false),
  rarity: text('rarity'),
  enchantValue: integer('enchant_value').default(0),
  foodNutrition: integer('food_nutrition'),
  foodSaturation: real('food_saturation'),
  foodAlwaysEat: integer('food_always_eat', { mode: 'boolean' }),
  defaultComponentsJson: text('default_components_json'),
});

/**
 * 方块专属事实表
 */
export const blocks = sqliteTable('blocks', {
  blockId: text('block_id').primaryKey(),
  itemId: text('item_id').references(() => items.itemId),
  hardness: real('hardness'),
  resistance: real('resistance'),
  lightEmission: integer('light_emission'),
  requiresCorrectTool: integer('requires_correct_tool', { mode: 'boolean' }),
  soundType: text('sound_type'),
});

/**
 * 物品创造模式标签页关联表
 */
export const itemCreativeTabs = sqliteTable('item_creative_tabs', {
  itemId: text('item_id').notNull().references(() => items.itemId),
  tabId: text('tab_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.itemId, table.tabId] }),
}));

/**
 * 物品标签关联表
 */
export const itemTags = sqliteTable('item_tags', {
  tagId: text('tag_id').notNull(),
  itemId: text('item_id').notNull().references(() => items.itemId),
}, (table) => ({
  pk: primaryKey({ columns: [table.tagId, table.itemId] }),
}));

/**
 * 配方表
 */
export const recipes = sqliteTable('recipes', {
  recipeId: text('recipe_id').primaryKey(),
  typeId: text('type_id').notNull(),
  modid: text('modid').notNull().references(() => mods.modid),
  hash: text('hash').notNull(),
  rawJson: text('raw_json'),
  unparsed: integer('unparsed', { mode: 'boolean' }).notNull().default(false),
  group: text('group'),
  /** 有序合成网格宽（契约 v3+；非有序配方为 null） */
  inputWidth: integer('input_width'),
  /** 有序合成网格高 */
  inputHeight: integer('input_height'),
});

/**
 * 结构化配方输入表
 */
export const recipeInputs = sqliteTable('recipe_inputs', {
  recipeId: text('recipe_id').notNull().references(() => recipes.recipeId),
  slot: integer('slot').notNull(),
  role: text('role').notNull(),
  kind: text('kind').notNull(),
  ref: text('ref'),
  count: integer('count').notNull().default(1),
}, (table) => ({
  pk: primaryKey({ columns: [table.recipeId, table.slot, table.role, table.kind, table.ref] }),
}));

/**
 * 结构化配方输出表
 */
export const recipeOutputs = sqliteTable('recipe_outputs', {
  recipeId: text('recipe_id').notNull().references(() => recipes.recipeId),
  slot: integer('slot').notNull(),
  itemId: text('item_id').notNull().references(() => items.itemId),
  count: integer('count').notNull().default(1),
  componentsJson: text('components_json'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
}, (table) => ({
  pk: primaryKey({ columns: [table.recipeId, table.slot, table.itemId] }),
}));

/**
 * 翻译表
 */
export const translations = sqliteTable('translations', {
  key: text('key').notNull(),
  lang: text('lang').notNull(),
  value: text('value').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.key, table.lang] }),
}));

/**
 * 物品资源表
 */
export const itemResources = sqliteTable('item_resources', {
  itemId: text('item_id').notNull().references(() => items.itemId),
  resourceType: text('resource_type').notNull(),
  namespace: text('namespace').notNull(),
  path: text('path').notNull(),
  content: text('content'),
}, (table) => ({
  pk: primaryKey({ columns: [table.itemId, table.resourceType, table.namespace, table.path] }),
}));

/**
 * 配方视图布局表
 */
export const recipeViews = sqliteTable('recipe_views', {
  typeId: text('type_id').primaryKey(),
  layoutJson: text('layout_json').notNull(),
  base64Png: text('base64_png'),
  version: integer('version'),
});

/**
 * 配方视图背景图表
 */
export const recipeViewBackgrounds = sqliteTable('recipe_view_backgrounds', {
  typeId: text('type_id').primaryKey(),
  png: blob('png').notNull(),
  sha1: text('sha1').notNull(),
});

/**
 * 战利品表（契约 v2，最终态原始 JSON）
 */
export const lootTables = sqliteTable('loot_tables', {
  lootTableId: text('loot_table_id').primaryKey(),
  json: text('json').notNull(),
});

/**
 * 战利品表绑定（契约 v2，kind: block | entity）
 */
export const lootBindings = sqliteTable('loot_bindings', {
  kind: text('kind').notNull(),
  sourceId: text('source_id').notNull(),
  lootTableId: text('loot_table_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.kind, table.sourceId] }),
}));

/**
 * 物品战利品来源（导入时派生物化，见 mod-data-importer/loot-sources.ts）
 */
export const itemLootSources = sqliteTable('item_loot_sources', {
  itemId: text('item_id').notNull(),
  category: text('category').notNull(),
  sourceId: text('source_id').notNull(),
  lootTableId: text('loot_table_id').notNull(),
  occurrencesJson: text('occurrences_json').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.itemId, table.category, table.sourceId, table.lootTableId] }),
}));

// ============================================================================
// 项目工作区数据（用户编辑内容）
// ============================================================================

/**
 * 配方类型显示名称映射（用于覆盖或补充）
 */
export const recipeTypeDisplayNames = sqliteTable('recipe_type_display_names', {
  typeId: text('type_id').primaryKey(),
  displayName: text('display_name').notNull(),
  icon: text('icon'),
  inputSlotCount: integer('input_slot_count').default(1),
  outputSlotCount: integer('output_slot_count').default(1),
});

/**
 * 配方编辑历史 - 用户对配方的修改记录
 */
export const recipeEdits = sqliteTable('recipe_edits', {
  editId: text('edit_id').primaryKey(),
  recipeId: text('recipe_id').notNull(),
  editType: text('edit_type', { enum: ['create', 'modify', 'disable', 'delete', 'restore'] }).notNull(),
  originalRecipe: text('original_recipe'),
  editedRecipe: text('edited_recipe').notNull(),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  isExported: integer('is_exported', { mode: 'boolean' }).notNull().default(false),
  exportedAt: text('exported_at'),
});

/**
 * 导出历史
 */
export const exportHistory = sqliteTable('export_history', {
  exportId: text('export_id').primaryKey(),
  exportType: text('export_type', { enum: ['kubejs', 'datapack'] }).notNull(),
  targetPath: text('target_path').notNull(),
  exportedEditIds: text('exported_edit_ids'),
  exportedFiles: text('exported_files'),
  exportedAt: text('exported_at').notNull(),
  isSuccess: integer('is_success', { mode: 'boolean' }).notNull().default(true),
  errorMessage: text('error_message'),
});

/**
 * 数据导入历史
 */
export const dataImports = sqliteTable('data_imports', {
  importId: text('import_id').primaryKey(),
  sourceFilePath: text('source_file_path').notNull(),
  sourceKind: text('source_kind', { enum: ['exporter_v1', 'legacy_exporter'] }).notNull().default('legacy_exporter'),
  dataVersion: text('data_version').notNull(),
  schemaVersion: text('schema_version').notNull().default('1.0'),
  capabilitiesJson: text('capabilities_json').notNull(),
  modlistHash: text('modlist_hash'),
  exportedAt: text('exported_at'),
  modCount: integer('mod_count').notNull().default(0),
  itemCount: integer('item_count').notNull().default(0),
  recipeCount: integer('recipe_count').notNull().default(0),
  tagCount: integer('tag_count').notNull().default(0),
  importedAt: text('imported_at').notNull(),
  isSuccess: integer('is_success', { mode: 'boolean' }).notNull().default(true),
  errorMessage: text('error_message'),
});

/**
 * 手动动作方案
 */
export const plans = sqliteTable('plans', {
  planId: text('plan_id').primaryKey(),
  name: text('name').notNull(),
  action: text('action').notNull(),
  paramsJson: text('params_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  notes: text('notes'),
});

/**
 * 方案 dry-run 快照
 */
export const planSnapshots = sqliteTable('plan_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  planId: text('plan_id').notNull().references(() => plans.planId),
  resultJson: text('result_json').notNull(),
  generatedFilesJson: text('generated_files_json'),
  createdAt: text('created_at').notNull(),
});

/**
 * Agent 语义层框架：运行记录（M4）
 */
export const agentRuns = sqliteTable('agent_runs', {
  runId: text('run_id').primaryKey(),
  mode: text('mode').notNull(),
  status: text('status').notNull(),
  stage: text('stage').notNull(),
  userInput: text('user_input').notNull(),
  requestJson: text('request_json').notNull(),
  outputJson: text('output_json'),
  progressJson: text('progress_json').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Agent 语义层框架：Intent Spec 持久化
 */
export const intentSpecs = sqliteTable('intent_specs', {
  specId: text('spec_id').primaryKey(),
  userInput: text('user_input').notNull(),
  mode: text('mode').notNull(),
  specJson: text('spec_json').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Gate 1 审核账本框架
 */
export const gateReviews = sqliteTable('gate_reviews', {
  reviewId: text('review_id').primaryKey(),
  specId: text('spec_id').notNull(),
  status: text('status').notNull(),
  requestJson: text('request_json').notNull(),
  ledgerJson: text('ledger_json').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

/**
 * 引导式规划框架（M3）
 */
export const guidedSessions = sqliteTable('guided_sessions', {
  sessionId: text('session_id').primaryKey(),
  userInput: text('user_input').notNull(),
  viewJson: text('view_json'),
  status: text('status').notNull(),
  committedSpecId: text('committed_spec_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * 探测+搁置框架（M5）
 */
export const detectReports = sqliteTable('detect_reports', {
  reportId: text('report_id').primaryKey(),
  source: text('source').notNull(),
  reportJson: text('report_json').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ============================================================================
// Type Exports
// ============================================================================

export type SchemaVersion = typeof schemaVersion.$inferSelect;
export type Manifest = typeof manifest.$inferSelect;
export type Mod = typeof mods.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type ItemCreativeTab = typeof itemCreativeTabs.$inferSelect;
export type ItemTag = typeof itemTags.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type RecipeInput = typeof recipeInputs.$inferSelect;
export type RecipeOutput = typeof recipeOutputs.$inferSelect;
export type Translation = typeof translations.$inferSelect;
export type ItemResource = typeof itemResources.$inferSelect;
export type RecipeView = typeof recipeViews.$inferSelect;
export type RecipeViewBackground = typeof recipeViewBackgrounds.$inferSelect;
export type LootTable = typeof lootTables.$inferSelect;
export type LootBinding = typeof lootBindings.$inferSelect;
export type ItemLootSource = typeof itemLootSources.$inferSelect;
export type RecipeTypeDisplayName = typeof recipeTypeDisplayNames.$inferSelect;
export type RecipeEdit = typeof recipeEdits.$inferSelect;
export type ExportHistory = typeof exportHistory.$inferSelect;
export type DataImport = typeof dataImports.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanSnapshotRow = typeof planSnapshots.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type IntentSpecRow = typeof intentSpecs.$inferSelect;
export type GateReviewRow = typeof gateReviews.$inferSelect;
export type GuidedSessionRow = typeof guidedSessions.$inferSelect;
export type DetectReportRow = typeof detectReports.$inferSelect;
