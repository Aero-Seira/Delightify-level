/**
 * Mod Data Importer - Core Implementation
 * 
 * 根据 reference_sql/export.sqlite 样例实现
 */

import { createClient, Client } from '@libsql/client';
import * as path from 'path';
import * as crypto from 'crypto';
import type { 
  ModDataImportOptions, 
  ImportResult, 
  ImportProgress,
  ModEntry,
  ItemEntry,
  ItemTagEntry,
  RecipeEntry,
  ManifestEntry,
  ProjectCapabilities,
  DataSourceKind,
  BlockEntry,
  ItemCreativeTabEntry,
  RecipeInputEntry,
  RecipeOutputEntry,
  TranslationEntry,
  RecipeViewEntry,
  RecipeViewBackgroundEntry,
  LootTableEntry,
  LootBindingEntry,
  ItemLootSourceEntry,
} from './types';
import { LEGACY_EXPORTER_CAPABILITIES } from './types';
import { validateModDataFile, DATA_FILE_PATHS } from './validator';
import { deriveItemLootSources } from './loot-sources';
import { deriveGraph, writeGraph } from '../graph';
import { createSchemaManager } from '../database/schema-manager';

function generateId(): string {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

type DbRow = Record<string, unknown>;

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  return optionalNumber(value) ?? defaultValue;
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName],
  });
  return result.rows.length > 0;
}

/**
 * 导入 Mod 数据到项目数据库
 */
export async function importModData(options: ModDataImportOptions): Promise<ImportResult> {
  const { projectPath, dataFilePath: providedDataFilePath, onProgress } = options;
  
  const importId = generateId();
  const now = new Date().toISOString();
  let dataFilePathForHistory = providedDataFilePath || '';
  let sourceKindForHistory: DataSourceKind | undefined;
  
  try {
    // Step 1: 检测数据文件
    onProgress?.({
      phase: 'detecting',
      percent: 5,
      message: '检测数据文件...',
    });

    const dataFilePath = providedDataFilePath || await detectModDataFile(projectPath);
    dataFilePathForHistory = dataFilePath || dataFilePathForHistory;
    
    if (!dataFilePath) {
      throw new Error(`未找到数据文件。请确保已安装附属Mod并启动游戏。\n预期路径: ${DATA_FILE_PATHS.join(', ')}`);
    }

    // Step 2: 验证数据文件
    onProgress?.({
      phase: 'validating',
      percent: 10,
      message: '验证数据文件...',
    });

    const validation = await validateModDataFile(dataFilePath);
    sourceKindForHistory = validation.sourceKind;
    if (!validation.valid) {
      throw new Error(validation.error || '数据文件验证失败');
    }

    // Step 3: 读取源数据库
    onProgress?.({
      phase: 'reading',
      percent: 15,
      message: '读取数据...',
    });

    const sourceClient = createClient({ url: `file:${dataFilePath}` });
    
    let manifestData: ManifestEntry[] = [];
    let modsData: ModEntry[] = [];
    let itemsData: ItemEntry[] = [];
    let tagsData: ItemTagEntry[] = [];
    let recipesData: RecipeEntry[] = [];
    let resourcesData: any[] = [];
    let blocksData: BlockEntry[] = [];
    let creativeTabsData: ItemCreativeTabEntry[] = [];
    let recipeInputsData: RecipeInputEntry[] = [];
    let recipeOutputsData: RecipeOutputEntry[] = [];
    let translationsData: TranslationEntry[] = [];
    let recipeViewsData: RecipeViewEntry[] = [];
    let recipeViewBackgroundsData: RecipeViewBackgroundEntry[] = [];
    let lootTablesData: LootTableEntry[] = [];
    let lootBindingsData: LootBindingEntry[] = [];
    
    try {
      // 读取所有数据
      manifestData = await readManifest(sourceClient);
      modsData = await readMods(sourceClient);
      itemsData = await readItems(sourceClient);
      tagsData = await readItemTags(sourceClient);
      recipesData = await readRecipes(sourceClient);
      resourcesData = await readItemResources(sourceClient);
      blocksData = await readBlocks(sourceClient);
      creativeTabsData = await readItemCreativeTabs(sourceClient);
      recipeInputsData = await readRecipeInputs(sourceClient);
      recipeOutputsData = await readRecipeOutputs(sourceClient);
      translationsData = await readTranslations(sourceClient);
      recipeViewsData = await readRecipeViews(sourceClient);
      recipeViewBackgroundsData = await readRecipeViewBackgrounds(sourceClient);
      lootTablesData = await readLootTables(sourceClient);
      lootBindingsData = await readLootBindings(sourceClient);
    } finally {
      // 确保源连接被关闭
      try { await sourceClient.close(); } catch {}
    }

    // 派生「物品 → 战利品来源」物化视图（纯 CPU，放在事务外；契约 v2 快照缺表时为空）
    const lootSourcesData: ItemLootSourceEntry[] = deriveItemLootSources(lootTablesData, lootBindingsData, tagsData);

    // 派生游戏事实图谱（纯 CPU，放在事务外；graph_nodes/graph_edges 随事务物化）
    const enUsNames = new Map<string, string>();
    for (const t of translationsData) {
      if (t.lang === 'en_us') enUsNames.set(t.key, t.value);
    }
    const displayNames = new Map<string, string>();
    for (const item of itemsData) {
      const name = item.translation_key ? enUsNames.get(item.translation_key) : undefined;
      if (name) displayNames.set(item.item_id, name);
    }
    const graphData = deriveGraph({
      items: itemsData,
      tags: tagsData,
      recipes: recipesData,
      recipeInputs: recipeInputsData,
      recipeOutputs: recipeOutputsData,
      lootSources: lootSourcesData,
      displayNames,
    });

    const stats = {
      modCount: modsData.length,
      itemCount: itemsData.length,
      tagCount: tagsData.length,
      recipeCount: recipesData.length,
      resourceCount: resourcesData.length,
      blockCount: blocksData.length,
      creativeTabCount: creativeTabsData.length,
      recipeInputCount: recipeInputsData.length,
      recipeOutputCount: recipeOutputsData.length,
      translationCount: translationsData.length,
      recipeViewCount: recipeViewsData.length,
      recipeViewBackgroundCount: recipeViewBackgroundsData.length,
    };

    onProgress?.({
      phase: 'reading',
      percent: 25,
      message: `读取完成：${stats.modCount}个模组，${stats.itemCount}个物品，${stats.recipeCount}个配方`,
    });

    // Step 4: 导入到项目数据库
    onProgress?.({
      phase: 'importing',
      percent: 30,
      message: '准备导入...',
    });

    const projectDbPath = path.join(projectPath, '.delightify', 'project.db');
    
    // 确保目录存在
    const fs = await import('fs');
    const dbDir = path.dirname(projectDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    const targetClient = createClient({ url: `file:${projectDbPath}` });

    let transactionStarted = false;

    try {
      // 初始化/验证数据库结构
      onProgress?.({
        phase: 'importing',
        percent: 28,
        message: '初始化数据库结构...',
      });
      
      const schemaManager = createSchemaManager(targetClient);
      await schemaManager.initialize();
      
      // 验证数据库结构
      const schemaValidation = await schemaManager.validateSchema();
      if (!schemaValidation.valid) {
        console.warn('[Importer] Schema validation warnings:', schemaValidation);
        // 尝试修复缺失的表
        for (const tableName of schemaValidation.missingTables) {
          console.log(`[Importer] Creating missing table: ${tableName}`);
        }
      }

      await targetClient.execute('BEGIN');
      transactionStarted = true;
      
      // 清空现有数据
      await clearExistingData(targetClient);

      // 导入 manifest
      onProgress?.({
        phase: 'importing',
        percent: 30,
        message: '导入清单...',
      });
      await importManifest(targetClient, manifestData);

      // 导入模组
      onProgress?.({
        phase: 'importing',
        percent: 35,
        message: `导入模组... (${modsData.length})`,
      });
      await importMods(targetClient, modsData);

      // 导入物品
      onProgress?.({
        phase: 'importing',
        percent: 45,
        message: `导入物品... (${itemsData.length})`,
      });
      await importItems(targetClient, itemsData);

      // 导入方块事实
      onProgress?.({
        phase: 'importing',
        percent: 50,
        message: `导入方块事实... (${blocksData.length})`,
      });
      await importBlocks(targetClient, blocksData);

      // 导入创造模式标签页
      onProgress?.({
        phase: 'importing',
        percent: 55,
        message: `导入创造模式标签页... (${creativeTabsData.length})`,
      });
      await importItemCreativeTabs(targetClient, creativeTabsData);

      // 导入标签
      onProgress?.({
        phase: 'importing',
        percent: 60,
        message: `导入标签... (${tagsData.length})`,
      });
      await importItemTags(targetClient, tagsData);

      // 导入配方
      onProgress?.({
        phase: 'importing',
        percent: 75,
        message: `导入配方... (${recipesData.length})`,
      });
      await importRecipes(targetClient, recipesData);

      // 导入结构化配方输入/输出
      onProgress?.({
        phase: 'importing',
        percent: 80,
        message: `导入结构化配方... (${recipeInputsData.length}/${recipeOutputsData.length})`,
      });
      await importRecipeInputs(targetClient, recipeInputsData);
      await importRecipeOutputs(targetClient, recipeOutputsData);

      // 导入翻译
      onProgress?.({
        phase: 'importing',
        percent: 83,
        message: `导入翻译... (${translationsData.length})`,
      });
      await importTranslations(targetClient, translationsData);

      // 导入资源
      onProgress?.({
        phase: 'importing',
        percent: 85,
        message: `导入资源... (${resourcesData.length})`,
      });
      await importItemResources(targetClient, resourcesData);

      // 导入配方视图
      onProgress?.({
        phase: 'importing',
        percent: 90,
        message: `导入配方视图... (${recipeViewsData.length})`,
      });
      await importRecipeViews(targetClient, recipeViewsData);
      await importRecipeViewBackgrounds(targetClient, recipeViewBackgroundsData);

      // 导入战利品表 + 派生来源（契约 v2；旧快照为空，自动跳过）
      onProgress?.({
        phase: 'importing',
        percent: 93,
        message: `导入战利品表... (${lootTablesData.length})`,
      });
      await importLootTables(targetClient, lootTablesData);
      await importLootBindings(targetClient, lootBindingsData);
      await importItemLootSources(targetClient, lootSourcesData);

      // 物化游戏事实图谱（派生/写入失败不阻塞导入本体）
      try {
        await writeGraph(targetClient, graphData);
      } catch (graphError) {
        console.warn('[Importer] Graph write skipped:', graphError);
      }

      // 记录导入历史
      await recordImportHistory(targetClient, {
        importId,
        sourceFilePath: dataFilePath,
        sourceKind: validation.sourceKind || 'legacy_exporter',
        dataVersion: validation.version || '1.0',
        schemaVersion: validation.schemaVersion || validation.version || '1.0',
        capabilities: validation.capabilities || {
          browse: true,
          mvp0Unify: false,
          reason: 'legacy_export_without_structured_recipes',
        },
        modlistHash: validation.modlistHash,
        exportedAt: validation.exportedAt || manifestData.find(m => m.key === 'exported_at_utc')?.value,
        ...stats,
        importedAt: now,
      });

      await targetClient.execute('COMMIT');
      transactionStarted = false;

      onProgress?.({
        phase: 'completed',
        percent: 100,
        message: '导入完成！',
      });

      return {
        success: true,
        importId,
        sourceKind: validation.sourceKind || 'legacy_exporter',
        capabilities: validation.capabilities,
        stats,
      };
    } catch (error) {
      if (transactionStarted) {
        try { await targetClient.execute('ROLLBACK'); } catch {}
      }
      throw error;
    } finally {
      // 确保目标连接被关闭
      try { await targetClient.close(); } catch {}
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '导入数据失败';
    await recordFailedImport({
      projectPath,
      importId,
      sourceFilePath: dataFilePathForHistory,
      sourceKind: sourceKindForHistory,
      errorMessage,
      importedAt: now,
    });
    onProgress?.({
      phase: 'error',
      percent: 0,
      message: `导入失败: ${errorMessage}`,
    });
    return {
      success: false,
      importId,
      error: errorMessage,
    };
  }
}

/**
 * 检测整合包中的数据文件
 */
export async function detectModDataFile(projectPath: string): Promise<string | null> {
  console.log('[Importer] detectModDataFile called with path:', projectPath);
  const fs = await import('fs/promises');
  
  for (const relativePath of DATA_FILE_PATHS) {
    const filePath = path.join(projectPath, relativePath);
    console.log('[Importer] Checking path:', filePath);
    try {
      await fs.access(filePath);
      console.log('[Importer] File found:', filePath);
      return filePath;
    } catch {
      console.log('[Importer] File not found:', filePath);
      // 文件不存在，继续检查下一个
    }
  }

  console.log('[Importer] No data file found in any path');
  return null;
}

/**
 * 清空现有数据
 */
async function clearExistingData(client: Client): Promise<void> {
  const tables = [
    'item_loot_sources',
    'loot_bindings',
    'loot_tables',
    'recipe_view_backgrounds',
    'recipe_views',
    'translations',
    'recipe_outputs',
    'recipe_inputs',
    'recipes',
    'item_tags',
    'item_creative_tabs',
    'blocks',
    'item_resources',
    'items',
    'mods',
    'manifest',
  ];
  for (const table of tables) {
    try {
      await client.execute(`DELETE FROM "${table}"`);
    } catch (error) {
      // 表可能不存在，忽略错误
      console.log(`[Importer] Clear table ${table} skipped (may not exist)`);
    }
  }
}

// ============================================================================
// 读取数据函数
// ============================================================================

async function readManifest(client: Client): Promise<ManifestEntry[]> {
  const result = await client.execute('SELECT * FROM manifest');
  return result.rows.map(row => ({
    key: row.key as string,
    value: row.value as string,
  }));
}

async function readMods(client: Client): Promise<ModEntry[]> {
  const result = await client.execute('SELECT * FROM mods');
  const entries: ModEntry[] = [];
  
  for (const row of result.rows) {
    const modid = row.modid as string | null;
    
    // 跳过无效记录
    if (!modid) {
      console.warn(`[Importer] Skipping invalid mod: missing modid`);
      continue;
    }
    
    entries.push({
      modid,
      version: (row.version as string) || undefined,
      name: (row.name as string) || undefined,
    });
  }
  
  return entries;
}

async function readItems(client: Client): Promise<ItemEntry[]> {
  const result = await client.execute('SELECT * FROM items');
  const entries: ItemEntry[] = [];
  
  for (const row of result.rows) {
    const item_id = row.item_id as string | null;
    const modid = row.modid as string | null;
    
    // 跳过无效记录
    if (!item_id || !modid) {
      console.warn(`[Importer] Skipping invalid item: missing required field (item_id=${item_id}, modid=${modid})`);
      continue;
    }
    
    entries.push({
      item_id,
      modid,
      translation_key: optionalString(row.translation_key),
      is_block: numberOrDefault(row.is_block, 0),
      max_stack: numberOrDefault(row.max_stack, 64),
      max_damage: numberOrDefault(row.max_damage, 0),
      is_damageable: numberOrDefault(row.is_damageable, 0),
      is_fire_resistant: numberOrDefault(row.is_fire_resistant, 0),
      rarity: optionalString(row.rarity),
      enchant_value: optionalNumber(row.enchant_value),
      food_nutrition: optionalNumber(row.food_nutrition),
      food_saturation: optionalNumber(row.food_saturation),
      food_always_eat: optionalNumber(row.food_always_eat),
      default_components_json: optionalString(row.default_components_json),
    });
  }
  
  return entries;
}

async function readItemTags(client: Client): Promise<ItemTagEntry[]> {
  const result = await client.execute('SELECT * FROM item_tags');
  const entries: ItemTagEntry[] = [];
  
  for (const row of result.rows) {
    const tag_id = row.tag_id as string | null;
    const item_id = row.item_id as string | null;
    
    // 跳过无效记录
    if (!tag_id || !item_id) {
      console.warn(`[Importer] Skipping invalid tag: missing required field (tag_id=${tag_id}, item_id=${item_id})`);
      continue;
    }
    
    entries.push({ tag_id, item_id });
  }
  
  return entries;
}

async function readRecipes(client: Client): Promise<RecipeEntry[]> {
  const result = await client.execute('SELECT * FROM recipes');
  const entries: RecipeEntry[] = [];
  
  for (const row of result.rows) {
    // 包容性处理：处理可能缺失或空的字段
    const recipe_id = row.recipe_id as string | null;
    const type_id = row.type_id as string | null;
    const modid = row.modid as string | null;
    const hash = row.hash as string | null;
    
    // 跳过无效记录
    if (!recipe_id || !type_id || !modid) {
      console.warn(`[Importer] Skipping invalid recipe: missing required field (recipe_id=${recipe_id}, type_id=${type_id}, modid=${modid})`);
      continue;
    }
    
    entries.push({
      recipe_id,
      type_id,
      modid,
      hash: hash || '', // hash 缺失时使用空字符串
      raw_json: (row.raw_json as string) || undefined,
      unparsed: String(row.unparsed) === '1' || String(row.unparsed) === 'true',
      group: (row.group as string) || null,
      // 契约 v3+ 才有这两列；旧快照 SELECT * 取不到键，optionalNumber 归一为 null
      input_width: optionalNumber(row.input_width),
      input_height: optionalNumber(row.input_height),
    });
  }
  
  return entries;
}

async function readBlocks(client: Client): Promise<BlockEntry[]> {
  if (!await tableExists(client, 'blocks')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM blocks');
  const entries: BlockEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const block_id = optionalString(row.block_id);
    if (!block_id) {
      console.warn('[Importer] Skipping invalid block: missing block_id');
      continue;
    }

    entries.push({
      block_id,
      item_id: optionalString(row.item_id),
      hardness: optionalNumber(row.hardness),
      resistance: optionalNumber(row.resistance),
      light_emission: optionalNumber(row.light_emission),
      requires_correct_tool: optionalNumber(row.requires_correct_tool),
      sound_type: optionalString(row.sound_type),
    });
  }

  return entries;
}

async function readItemCreativeTabs(client: Client): Promise<ItemCreativeTabEntry[]> {
  if (!await tableExists(client, 'item_creative_tabs')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM item_creative_tabs');
  const entries: ItemCreativeTabEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const item_id = optionalString(row.item_id);
    const tab_id = optionalString(row.tab_id);
    if (!item_id || !tab_id) {
      console.warn('[Importer] Skipping invalid creative tab entry');
      continue;
    }
    entries.push({ item_id, tab_id });
  }

  return entries;
}

async function readRecipeInputs(client: Client): Promise<RecipeInputEntry[]> {
  if (!await tableExists(client, 'recipe_inputs')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM recipe_inputs');
  const entries: RecipeInputEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const recipe_id = optionalString(row.recipe_id);
    const role = optionalString(row.role);
    const kind = optionalString(row.kind);
    const slot = optionalNumber(row.slot);
    if (!recipe_id || !role || !kind || slot === null) {
      console.warn('[Importer] Skipping invalid recipe input entry');
      continue;
    }

    entries.push({
      recipe_id,
      slot,
      role,
      kind,
      ref: optionalString(row.ref),
      count: numberOrDefault(row.count, 1),
    });
  }

  return entries;
}

async function readRecipeOutputs(client: Client): Promise<RecipeOutputEntry[]> {
  if (!await tableExists(client, 'recipe_outputs')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM recipe_outputs');
  const entries: RecipeOutputEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const recipe_id = optionalString(row.recipe_id);
    const item_id = optionalString(row.item_id);
    const slot = optionalNumber(row.slot);
    if (!recipe_id || !item_id || slot === null) {
      console.warn('[Importer] Skipping invalid recipe output entry');
      continue;
    }

    entries.push({
      recipe_id,
      slot,
      item_id,
      count: numberOrDefault(row.count, 1),
      components_json: optionalString(row.components_json),
      is_primary: numberOrDefault(row.is_primary, 1),
    });
  }

  return entries;
}

async function readTranslations(client: Client): Promise<TranslationEntry[]> {
  if (!await tableExists(client, 'translations')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM translations');
  const entries: TranslationEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const key = optionalString(row.key);
    const lang = optionalString(row.lang);
    const value = optionalString(row.value);
    if (!key || !lang || value === null) {
      console.warn('[Importer] Skipping invalid translation entry');
      continue;
    }
    entries.push({ key, lang, value });
  }

  return entries;
}

async function readRecipeViews(client: Client): Promise<RecipeViewEntry[]> {
  if (!await tableExists(client, 'recipe_views')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM recipe_views');
  const entries: RecipeViewEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const type_id = optionalString(row.type_id);
    const layout_json = optionalString(row.layout_json);
    if (!type_id || !layout_json) {
      console.warn('[Importer] Skipping invalid recipe view entry');
      continue;
    }
    entries.push({
      type_id,
      layout_json,
      base64_png: optionalString(row.base64_png),
      version: optionalNumber(row.version),
    });
  }

  return entries;
}

async function readRecipeViewBackgrounds(client: Client): Promise<RecipeViewBackgroundEntry[]> {
  if (!await tableExists(client, 'recipe_view_backgrounds')) {
    return [];
  }

  const result = await client.execute('SELECT * FROM recipe_view_backgrounds');
  const entries: RecipeViewBackgroundEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const type_id = optionalString(row.type_id);
    const sha1 = optionalString(row.sha1);
    const png = row.png;
    if (!type_id || !sha1 || !(png instanceof ArrayBuffer || png instanceof Uint8Array)) {
      console.warn('[Importer] Skipping invalid recipe view background entry');
      continue;
    }
    entries.push({ type_id, png, sha1 });
  }

  return entries;
}

async function readLootTables(client: Client): Promise<LootTableEntry[]> {
  // 契约 v2 新增；v1/legacy 快照无此表，静默跳过
  if (!await tableExists(client, 'loot_tables')) {
    return [];
  }

  const result = await client.execute('SELECT loot_table_id, json FROM loot_tables');
  const entries: LootTableEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const loot_table_id = optionalString(row.loot_table_id);
    const json = optionalString(row.json);
    if (!loot_table_id || !json) {
      console.warn('[Importer] Skipping invalid loot table entry');
      continue;
    }
    entries.push({ loot_table_id, json });
  }

  return entries;
}

async function readLootBindings(client: Client): Promise<LootBindingEntry[]> {
  if (!await tableExists(client, 'loot_bindings')) {
    return [];
  }

  const result = await client.execute('SELECT kind, source_id, loot_table_id FROM loot_bindings');
  const entries: LootBindingEntry[] = [];

  for (const row of result.rows as DbRow[]) {
    const kind = optionalString(row.kind);
    const source_id = optionalString(row.source_id);
    const loot_table_id = optionalString(row.loot_table_id);
    if (!kind || !source_id || !loot_table_id) {
      console.warn('[Importer] Skipping invalid loot binding entry');
      continue;
    }
    entries.push({ kind, source_id, loot_table_id });
  }

  return entries;
}

// ============================================================================
// 导入数据函数
// ============================================================================

async function importManifest(client: Client, entries: ManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    await client.execute({
      sql: 'INSERT INTO manifest (key, value) VALUES (?, ?)',
      args: [entry.key, entry.value],
    });
  }
}

async function importMods(client: Client, mods: ModEntry[]): Promise<void> {
  if (mods.length === 0) {
    console.log('[Importer] No mods to import');
    return;
  }
  
  let successCount = 0;
  
  for (const mod of mods) {
    // 跳过无效数据
    if (!mod.modid) {
      console.warn(`[Importer] Skipping invalid mod:`, mod);
      continue;
    }
    
    try {
      await client.execute({
        sql: 'INSERT INTO mods (modid, version, name) VALUES (?, ?, ?)',
        args: [
          mod.modid,
          mod.version || null,
          mod.name || null,
        ],
      });
      successCount++;
    } catch (error) {
      // 可能是重复键
      if ((error as Error).message?.includes('UNIQUE constraint failed')) {
        console.warn(`[Importer] Duplicate mod skipped: ${mod.modid}`);
      } else {
        console.error(`[Importer] Failed to insert mod ${mod.modid}:`, error);
      }
    }
  }
  
  console.log(`[Importer] Mods imported: ${successCount}/${mods.length}`);
}

async function importItems(client: Client, items: ItemEntry[]): Promise<void> {
  if (items.length === 0) {
    console.log('[Importer] No items to import');
    return;
  }
  
  // 使用批量插入提高效率
  const batchSize = 500;
  let successCount = 0;
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    
    // 过滤无效数据
    const validBatch = batch.filter(item => {
      if (!item.item_id || !item.modid) {
        console.warn(`[Importer] Skipping invalid item in batch:`, item);
        return false;
      }
      return true;
    });
    
    if (validBatch.length === 0) continue;
    
    const values = validBatch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const args = validBatch.flatMap(item => [
      item.item_id,
      item.modid,
      item.translation_key || null,
      item.is_block ?? 0,
      item.max_stack ?? 64,
      item.max_damage ?? 0,
      item.is_damageable ?? 0,
      item.is_fire_resistant ?? 0,
      item.rarity || null,
      item.enchant_value ?? 0,
      item.food_nutrition ?? null,
      item.food_saturation ?? null,
      item.food_always_eat ?? null,
      item.default_components_json || null,
    ]);
    
    try {
      await client.execute({
        sql: `INSERT INTO items (
          item_id,
          modid,
          translation_key,
          is_block,
          max_stack,
          max_damage,
          is_damageable,
          is_fire_resistant,
          rarity,
          enchant_value,
          food_nutrition,
          food_saturation,
          food_always_eat,
          default_components_json
        ) VALUES ${values}`,
        args,
      });
      successCount += validBatch.length;
    } catch (error) {
      console.error(`[Importer] Failed to insert item batch ${i}-${i + batchSize}:`, error);
      
      // 尝试逐条插入
      for (const item of validBatch) {
        try {
          await client.execute({
            sql: `INSERT INTO items (
              item_id,
              modid,
              translation_key,
              is_block,
              max_stack,
              max_damage,
              is_damageable,
              is_fire_resistant,
              rarity,
              enchant_value,
              food_nutrition,
              food_saturation,
              food_always_eat,
              default_components_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              item.item_id,
              item.modid,
              item.translation_key || null,
              item.is_block ?? 0,
              item.max_stack ?? 64,
              item.max_damage ?? 0,
              item.is_damageable ?? 0,
              item.is_fire_resistant ?? 0,
              item.rarity || null,
              item.enchant_value ?? 0,
              item.food_nutrition ?? null,
              item.food_saturation ?? null,
              item.food_always_eat ?? null,
              item.default_components_json || null,
            ],
          });
        } catch (singleError) {
          // 可能是重复键，记录但不中断
          if ((singleError as Error).message?.includes('UNIQUE constraint failed')) {
            console.warn(`[Importer] Duplicate item skipped: ${item.item_id}`);
          } else {
            console.error(`[Importer] Failed to insert item ${item.item_id}:`, singleError);
          }
        }
      }
    }
  }
  
  console.log(`[Importer] Items imported: ${successCount}/${items.length}`);
}

async function importItemTags(client: Client, tags: ItemTagEntry[]): Promise<void> {
  if (tags.length === 0) {
    console.log('[Importer] No tags to import');
    return;
  }
  
  // 使用批量插入
  const batchSize = 500;
  let successCount = 0;
  
  for (let i = 0; i < tags.length; i += batchSize) {
    const batch = tags.slice(i, i + batchSize);
    
    // 过滤无效数据
    const validBatch = batch.filter(tag => {
      if (!tag.tag_id || !tag.item_id) {
        console.warn(`[Importer] Skipping invalid tag in batch:`, tag);
        return false;
      }
      return true;
    });
    
    if (validBatch.length === 0) continue;
    
    const values = validBatch.map(() => '(?, ?)').join(',');
    const args = validBatch.flatMap(tag => [tag.tag_id, tag.item_id]);
    
    try {
      await client.execute({
        sql: `INSERT INTO item_tags (tag_id, item_id) VALUES ${values}`,
        args,
      });
      successCount += validBatch.length;
    } catch (error) {
      console.error(`[Importer] Failed to insert tag batch ${i}-${i + batchSize}:`, error);
      
      // 尝试逐条插入
      for (const tag of validBatch) {
        try {
          await client.execute({
            sql: 'INSERT INTO item_tags (tag_id, item_id) VALUES (?, ?)',
            args: [tag.tag_id, tag.item_id],
          });
        } catch (singleError) {
          // 可能是重复键
          if ((singleError as Error).message?.includes('UNIQUE constraint failed')) {
            console.warn(`[Importer] Duplicate tag skipped: ${tag.tag_id} -> ${tag.item_id}`);
          } else {
            console.error(`[Importer] Failed to insert tag ${tag.tag_id} -> ${tag.item_id}:`, singleError);
          }
        }
      }
    }
  }
  
  console.log(`[Importer] Tags imported: ${successCount}/${tags.length}`);
}

async function importRecipes(client: Client, recipes: RecipeEntry[]): Promise<void> {
  if (recipes.length === 0) {
    console.log('[Importer] No recipes to import');
    return;
  }
  
  // 使用批量插入
  const batchSize = 200;
  let successCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < recipes.length; i += batchSize) {
    const batch = recipes.slice(i, i + batchSize);
    
    // 过滤无效数据
    const validBatch = batch.filter(recipe => {
      if (!recipe.recipe_id || !recipe.type_id || !recipe.modid) {
        console.warn(`[Importer] Skipping invalid recipe in batch:`, recipe);
        errorCount++;
        return false;
      }
      return true;
    });
    
    if (validBatch.length === 0) continue;
    
    const values = validBatch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const args = validBatch.flatMap(recipe => [
      recipe.recipe_id,
      recipe.type_id,
      recipe.modid,
      recipe.hash || '', // hash 缺失时使用空字符串
      recipe.raw_json || null, // raw_json 为空时使用 null
      recipe.unparsed ? 1 : 0,
      recipe.group || null,
      recipe.input_width ?? null,
      recipe.input_height ?? null,
    ]);
    
    try {
      await client.execute({
        sql: `INSERT INTO recipes (recipe_id, type_id, modid, hash, raw_json, unparsed, "group", input_width, input_height) VALUES ${values}`,
        args,
      });
      successCount += validBatch.length;
    } catch (error) {
      console.error(`[Importer] Failed to insert recipe batch ${i}-${i + batchSize}:`, error);
      errorCount += validBatch.length;
      
      // 尝试逐条插入，跳过有问题的记录
      for (const recipe of validBatch) {
        try {
          await client.execute({
            sql: 'INSERT INTO recipes (recipe_id, type_id, modid, hash, raw_json, unparsed, "group", input_width, input_height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            args: [
              recipe.recipe_id,
              recipe.type_id,
              recipe.modid,
              recipe.hash || '',
              recipe.raw_json || null,
              recipe.unparsed ? 1 : 0,
              recipe.group || null,
              recipe.input_width ?? null,
              recipe.input_height ?? null,
            ],
          });
        } catch (singleError) {
          console.error(`[Importer] Failed to insert recipe ${recipe.recipe_id}:`, singleError);
        }
      }
    }
  }
  
  console.log(`[Importer] Recipes imported: ${successCount} success, ${errorCount} errors`);
}

async function importRows<T>(
  client: Client,
  label: string,
  entries: T[],
  batchSize: number,
  insertSql: string,
  placeholders: string,
  argsForEntry: (entry: T) => any[]
): Promise<void> {
  if (entries.length === 0) {
    console.log(`[Importer] No ${label} to import`);
    return;
  }

  let successCount = 0;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const values = batch.map(() => placeholders).join(',');
    const args = batch.flatMap(argsForEntry);

    try {
      await client.execute({
        sql: `${insertSql} VALUES ${values}`,
        args,
      });
      successCount += batch.length;
    } catch (error) {
      console.error(`[Importer] Failed to insert ${label} batch ${i}-${i + batchSize}:`, error);

      for (const entry of batch) {
        try {
          await client.execute({
            sql: `${insertSql} VALUES ${placeholders}`,
            args: argsForEntry(entry),
          });
          successCount++;
        } catch (singleError) {
          if ((singleError as Error).message?.includes('UNIQUE constraint failed')) {
            console.warn(`[Importer] Duplicate ${label} skipped`);
          } else {
            console.error(`[Importer] Failed to insert ${label}:`, singleError);
          }
        }
      }
    }
  }

  console.log(`[Importer] ${label} imported: ${successCount}/${entries.length}`);
}

async function importBlocks(client: Client, blocks: BlockEntry[]): Promise<void> {
  await importRows(
    client,
    'blocks',
    blocks,
    300,
    `INSERT INTO blocks (
      block_id,
      item_id,
      hardness,
      resistance,
      light_emission,
      requires_correct_tool,
      sound_type
    )`,
    '(?, ?, ?, ?, ?, ?, ?)',
    block => [
      block.block_id,
      block.item_id || null,
      block.hardness ?? null,
      block.resistance ?? null,
      block.light_emission ?? null,
      block.requires_correct_tool ?? null,
      block.sound_type || null,
    ]
  );
}

async function importItemCreativeTabs(client: Client, tabs: ItemCreativeTabEntry[]): Promise<void> {
  await importRows(
    client,
    'item creative tabs',
    tabs,
    500,
    'INSERT INTO item_creative_tabs (item_id, tab_id)',
    '(?, ?)',
    tab => [tab.item_id, tab.tab_id]
  );
}

async function importRecipeInputs(client: Client, inputs: RecipeInputEntry[]): Promise<void> {
  await importRows(
    client,
    'recipe inputs',
    inputs,
    500,
    `INSERT INTO recipe_inputs (
      recipe_id,
      slot,
      role,
      kind,
      ref,
      count
    )`,
    '(?, ?, ?, ?, ?, ?)',
    input => [
      input.recipe_id,
      input.slot,
      input.role,
      input.kind,
      input.ref || null,
      input.count,
    ]
  );
}

async function importRecipeOutputs(client: Client, outputs: RecipeOutputEntry[]): Promise<void> {
  await importRows(
    client,
    'recipe outputs',
    outputs,
    500,
    `INSERT INTO recipe_outputs (
      recipe_id,
      slot,
      item_id,
      count,
      components_json,
      is_primary
    )`,
    '(?, ?, ?, ?, ?, ?)',
    output => [
      output.recipe_id,
      output.slot,
      output.item_id,
      output.count,
      output.components_json || null,
      output.is_primary,
    ]
  );
}

async function importTranslations(client: Client, translations: TranslationEntry[]): Promise<void> {
  await importRows(
    client,
    'translations',
    translations,
    500,
    'INSERT INTO translations ("key", lang, value)',
    '(?, ?, ?)',
    translation => [translation.key, translation.lang, translation.value]
  );
}

async function importRecipeViews(client: Client, views: RecipeViewEntry[]): Promise<void> {
  await importRows(
    client,
    'recipe views',
    views,
    100,
    'INSERT INTO recipe_views (type_id, layout_json, base64_png, version)',
    '(?, ?, ?, ?)',
    view => [
      view.type_id,
      view.layout_json,
      view.base64_png || null,
      view.version ?? null,
    ]
  );
}

async function importRecipeViewBackgrounds(
  client: Client,
  backgrounds: RecipeViewBackgroundEntry[]
): Promise<void> {
  await importRows(
    client,
    'recipe view backgrounds',
    backgrounds,
    50,
    'INSERT INTO recipe_view_backgrounds (type_id, png, sha1)',
    '(?, ?, ?)',
    background => [background.type_id, background.png, background.sha1]
  );
}

async function importLootTables(client: Client, tables: LootTableEntry[]): Promise<void> {
  await importRows(
    client,
    'loot tables',
    tables,
    200,
    'INSERT INTO loot_tables (loot_table_id, json)',
    '(?, ?)',
    table => [table.loot_table_id, table.json]
  );
}

async function importLootBindings(client: Client, bindings: LootBindingEntry[]): Promise<void> {
  await importRows(
    client,
    'loot bindings',
    bindings,
    500,
    'INSERT INTO loot_bindings (kind, source_id, loot_table_id)',
    '(?, ?, ?)',
    binding => [binding.kind, binding.source_id, binding.loot_table_id]
  );
}

async function importItemLootSources(client: Client, sources: ItemLootSourceEntry[]): Promise<void> {
  await importRows(
    client,
    'item loot sources',
    sources,
    500,
    'INSERT INTO item_loot_sources (item_id, category, source_id, loot_table_id, occurrences_json)',
    '(?, ?, ?, ?, ?)',
    source => [source.item_id, source.category, source.source_id, source.loot_table_id, source.occurrences_json]
  );
}

async function recordImportHistory(
  client: Client,
  data: {
    importId: string;
    sourceFilePath: string;
    sourceKind: DataSourceKind;
    dataVersion: string;
    schemaVersion: string;
    capabilities: ProjectCapabilities;
    modlistHash?: string;
    exportedAt?: string;
    modCount: number;
    itemCount: number;
    recipeCount: number;
    tagCount: number;
    importedAt: string;
  }
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO data_imports 
          (
            import_id,
            source_file_path,
            source_kind,
            data_version,
            schema_version,
            capabilities_json,
            modlist_hash,
            exported_at,
            mod_count,
            item_count,
            recipe_count,
            tag_count,
            imported_at,
            is_success
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      data.importId,
      data.sourceFilePath,
      data.sourceKind,
      data.dataVersion,
      data.schemaVersion,
      serializeCapabilities(data.capabilities),
      data.modlistHash || null,
      data.exportedAt || null,
      data.modCount,
      data.itemCount,
      data.recipeCount,
      data.tagCount,
      data.importedAt,
      1,
    ],
  });
}

async function recordFailedImport(data: {
  projectPath: string;
  importId: string;
  sourceFilePath: string;
  sourceKind?: DataSourceKind;
  errorMessage: string;
  importedAt: string;
}): Promise<void> {
  let client: Client | null = null;

  try {
    const projectDbPath = path.join(data.projectPath, '.delightify', 'project.db');
    const fs = await import('fs');
    const dbDir = path.dirname(projectDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    client = createClient({ url: `file:${projectDbPath}` });
    const schemaManager = createSchemaManager(client);
    await schemaManager.initialize();

    await client.execute({
      sql: `INSERT OR REPLACE INTO data_imports
            (
              import_id,
              source_file_path,
              source_kind,
              data_version,
              schema_version,
              capabilities_json,
              modlist_hash,
              exported_at,
              mod_count,
              item_count,
              recipe_count,
              tag_count,
              imported_at,
              is_success,
              error_message
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.importId,
        data.sourceFilePath || '',
        data.sourceKind || 'legacy_exporter',
        '1.0',
        '1.0',
        serializeCapabilities(LEGACY_EXPORTER_CAPABILITIES),
        null,
        null,
        0,
        0,
        0,
        0,
        data.importedAt,
        0,
        data.errorMessage,
      ],
    });
  } catch {
    // 失败审计不影响导入错误返回。
  } finally {
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}

function serializeCapabilities(capabilities: ProjectCapabilities): string {
  return JSON.stringify({
    browse: capabilities.browse,
    mvp0_unify: capabilities.mvp0Unify,
    reason: capabilities.reason,
  });
}

// ============================================================================
// Item Resources 读取和导入
// ============================================================================

interface ItemResourceEntry {
  item_id: string;
  resource_type: string;
  namespace: string;
  path: string;
  content: string | null;
}

async function readItemResources(client: Client): Promise<ItemResourceEntry[]> {
  // 检查表是否存在
  try {
    const tableCheck = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='item_resources'"
    );
    if (tableCheck.rows.length === 0) {
      console.log('[Importer] item_resources table does not exist, skipping');
      return [];
    }
  } catch {
    return [];
  }

  const result = await client.execute('SELECT * FROM item_resources');
  const entries: ItemResourceEntry[] = [];
  
  for (const row of result.rows) {
    const item_id = row.item_id as string | null;
    const resource_type = row.resource_type as string | null;
    const namespace = row.namespace as string | null;
    const path = row.path as string | null;
    
    // 跳过无效记录
    if (!item_id || !resource_type || !namespace || !path) {
      console.warn(`[Importer] Skipping invalid resource entry`);
      continue;
    }
    
    entries.push({
      item_id,
      resource_type,
      namespace,
      path,
      content: (row.content as string) || null,
    });
  }
  
  return entries;
}

async function importItemResources(client: Client, resources: ItemResourceEntry[]): Promise<void> {
  if (resources.length === 0) {
    console.log('[Importer] No resources to import');
    return;
  }
  
  console.log(`[Importer] Importing ${resources.length} resources`);
  
  // 使用批量插入
  const batchSize = 100;
  let successCount = 0;
  
  for (let i = 0; i < resources.length; i += batchSize) {
    const batch = resources.slice(i, i + batchSize);
    
    const values = batch.map(() => '(?, ?, ?, ?, ?)').join(',');
    const args = batch.flatMap(resource => [
      resource.item_id,
      resource.resource_type,
      resource.namespace,
      resource.path,
      resource.content,
    ]);
    
    try {
      await client.execute({
        sql: `INSERT INTO item_resources (item_id, resource_type, namespace, path, content) VALUES ${values}`,
        args,
      });
      successCount += batch.length;
    } catch (error) {
      console.error(`[Importer] Failed to insert resource batch ${i}-${i + batchSize}:`, error);
      
      // 尝试逐条插入
      for (const resource of batch) {
        try {
          await client.execute({
            sql: 'INSERT INTO item_resources (item_id, resource_type, namespace, path, content) VALUES (?, ?, ?, ?, ?)',
            args: [
              resource.item_id,
              resource.resource_type,
              resource.namespace,
              resource.path,
              resource.content,
            ],
          });
        } catch (singleError) {
          // 可能是重复键
          if ((singleError as Error).message?.includes('UNIQUE constraint failed')) {
            // 忽略重复
          } else {
            console.error(`[Importer] Failed to insert resource ${resource.item_id}/${resource.path}:`, singleError);
          }
        }
      }
    }
  }
  
  console.log(`[Importer] Resources imported: ${successCount}/${resources.length}`);
}
