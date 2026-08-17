/**
 * Mod Data Importer
 * 
 * 根据 reference_sql/export.sqlite 样例实现
 */

export { importModData, detectModDataFile } from './importer';
export { validateModDataFile, quickValidate, DATA_FILE_PATHS } from './validator';
export { deriveItemLootSources, classifyLootTable } from './loot-sources';

export type {
  ImportProgress,
  ImportResult,
  ModDataImportOptions,
  ValidationResult,
  DataSourceKind,
  ProjectCapabilities,
  ManifestEntry,
  ModEntry,
  ItemEntry,
  ItemTagEntry,
  RecipeEntry,
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
