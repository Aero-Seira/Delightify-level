/**
 * Mod Data Validator
 * 
 * 根据 reference_sql/export.sqlite 样例实现
 */

import { createClient } from '@libsql/client';
import type { DataSourceKind, ProjectCapabilities, ValidationResult } from './types';
import {
  DATA_FILE_PATHS,
  EXPORTER_V1_CAPABILITIES,
  EXPORTER_V1_REQUIRED_TABLES,
  LEGACY_EXPORTER_CAPABILITIES,
  LEGACY_REQUIRED_TABLES,
} from './types';

export { DATA_FILE_PATHS };

type LibsqlClient = ReturnType<typeof createClient>;

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasAllTables(tables: Set<string>, requiredTables: string[]): boolean {
  return requiredTables.every(table => tables.has(table));
}

function listMissingTables(tables: Set<string>, requiredTables: string[]): string[] {
  return requiredTables.filter(table => !tables.has(table));
}

async function readTableNames(client: LibsqlClient): Promise<Set<string>> {
  const result = await client.execute(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `);
  return new Set(result.rows.map(row => row.name as string));
}

async function readManifest(client: LibsqlClient): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();

  try {
    const result = await client.execute('SELECT key, value FROM manifest');
    for (const row of result.rows) {
      const key = row.key as string | undefined;
      const value = row.value as string | undefined;
      if (key && value !== undefined) {
        manifest.set(key, value);
      }
    }
  } catch {
    // 缺 manifest 会在表检测阶段报错，这里保持容错。
  }

  return manifest;
}

async function readSchemaVersion(client: LibsqlClient, manifest: Map<string, string>): Promise<string | undefined> {
  const manifestVersion = manifest.get('schema_version');
  if (manifestVersion) {
    return manifestVersion;
  }

  try {
    const result = await client.execute('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
    const version = result.rows[0]?.version;
    if (version !== undefined && version !== null) {
      return String(version);
    }
  } catch {
    // schema_version 表在 legacy 文件中可能不存在。
  }

  return undefined;
}

async function countRows(client: LibsqlClient, tableName: string): Promise<number> {
  const result = await client.execute(`SELECT COUNT(*) as count FROM "${tableName}"`);
  return Number(result.rows[0]?.count || 0);
}

function classifyDataSource(tables: Set<string>): { sourceKind: DataSourceKind; capabilities: ProjectCapabilities } | { error: string } {
  if (hasAllTables(tables, EXPORTER_V1_REQUIRED_TABLES)) {
    return {
      sourceKind: 'exporter_v1',
      capabilities: EXPORTER_V1_CAPABILITIES,
    };
  }

  const structuredTables = ['recipe_inputs', 'recipe_outputs', 'translations'];
  const hasPartialV1Tables = structuredTables.some(table => tables.has(table));
  if (hasPartialV1Tables) {
    const missingTables = listMissingTables(tables, EXPORTER_V1_REQUIRED_TABLES);
    return {
      error: `Exporter v1 数据文件缺少必需的表: ${missingTables.join(', ')}`,
    };
  }

  if (hasAllTables(tables, LEGACY_REQUIRED_TABLES)) {
    return {
      sourceKind: 'legacy_exporter',
      capabilities: LEGACY_EXPORTER_CAPABILITIES,
    };
  }

  const missingTables = listMissingTables(tables, LEGACY_REQUIRED_TABLES);
  return {
    error: `数据文件缺少必需的表: ${missingTables.join(', ')}`,
  };
}

/**
 * 验证数据文件
 * @param filePath 数据文件路径
 * @returns 验证结果
 */
export async function validateModDataFile(filePath: string): Promise<ValidationResult> {
  let client: ReturnType<typeof createClient> | null = null;
  
  try {
    const fs = await import('fs/promises');
    try {
      await fs.access(filePath);
    } catch {
      return { valid: false, error: '数据文件不存在' };
    }

    // 尝试连接数据库
    client = createClient({
      url: `file:${filePath}`,
    });

    const tables = await readTableNames(client);
    const classification = classifyDataSource(tables);
    if ('error' in classification) {
      return { valid: false, error: classification.error };
    }

    // 读取 manifest 获取元数据
    const manifest = await readManifest(client);
    const schemaVersion = await readSchemaVersion(client, manifest);
    const loader = toStringValue(manifest.get('loader'));
    const mcVersion = toStringValue(manifest.get('mc_version'));
    const minecraftVersion = toStringValue(manifest.get('minecraft_version')) || mcVersion;
    const forgeVersion = toStringValue(manifest.get('forge_version'));
    const exportedAt = toStringValue(manifest.get('exported_at_utc')) || toStringValue(manifest.get('exported_at'));
    const modlistHash = toStringValue(manifest.get('modlist_hash'));

    // 统计各项数量
    const [modsCount, itemsCount, recipesCount, tagsCount] = await Promise.all([
      countRows(client, 'mods'),
      countRows(client, 'items'),
      countRows(client, 'recipes'),
      countRows(client, 'item_tags'),
    ]);

    return {
      valid: true,
      version: schemaVersion || (classification.sourceKind === 'legacy_exporter' ? '1.0' : undefined),
      schemaVersion: schemaVersion || (classification.sourceKind === 'legacy_exporter' ? '1.0' : undefined),
      sourceKind: classification.sourceKind,
      capabilities: classification.capabilities,
      loader,
      mcVersion,
      minecraftVersion,
      forgeVersion,
      exportedAt,
      modlistHash,
      modCount: Number(manifest.get('mod_count')) || modsCount,
      itemCount: itemsCount,
      recipeCount: recipesCount,
      tagCount: tagsCount,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : '验证数据文件失败',
    };
  } finally {
    // 确保连接被关闭
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}

/**
 * 快速验证数据文件
 * @param filePath 数据文件路径
 * @returns 是否有效
 */
export async function quickValidate(filePath: string): Promise<boolean> {
  let client: ReturnType<typeof createClient> | null = null;
  
  try {
    const fs = await import('fs/promises');
    const stats = await fs.stat(filePath);
    
    if (!stats.isFile() || stats.size === 0) {
      return false;
    }

    client = createClient({
      url: `file:${filePath}`,
    });

    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='manifest'"
    );
    
    return result.rows.length > 0;
  } catch {
    return false;
  } finally {
    // 确保连接被关闭
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}
