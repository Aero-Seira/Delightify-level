/**
 * Schema Manager - 数据库 Schema 管理器
 * 
 * 提供灵活的数据库扩展机制：
 * 1. 自动检测并创建缺失的表
 * 2. 根据 manifest 动态添加字段
 * 3. 支持表结构迁移
 */

import type { Client } from '@libsql/client';

// ============================================================================
// 表结构定义
// ============================================================================

export interface ColumnDef {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  nullable?: boolean;
  default?: string | number;
  primaryKey?: boolean;
  references?: { table: string; column: string };
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  constraints?: string[];
  indexes?: string[];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function formatDefaultValue(value: string | number): string {
  if (typeof value === 'number') {
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

// 核心表结构定义
export const CORE_TABLES: TableDef[] = [
  {
    name: 'schema_version',
    columns: [
      { name: 'version', type: 'INTEGER', primaryKey: true },
    ],
  },
  {
    name: 'manifest',
    columns: [
      { name: 'key', type: 'TEXT', primaryKey: true },
      { name: 'value', type: 'TEXT', nullable: false },
    ],
  },
  {
    name: 'mods',
    columns: [
      { name: 'modid', type: 'TEXT', primaryKey: true },
      { name: 'version', type: 'TEXT', nullable: true },
      { name: 'name', type: 'TEXT', nullable: true },
    ],
  },
  {
    name: 'items',
    columns: [
      { name: 'item_id', type: 'TEXT', primaryKey: true },
      { name: 'modid', type: 'TEXT', nullable: false },
      { name: 'translation_key', type: 'TEXT', nullable: true },
      { name: 'is_block', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'max_stack', type: 'INTEGER', nullable: false, default: 64 },
      { name: 'max_damage', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'is_damageable', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'is_fire_resistant', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'rarity', type: 'TEXT', nullable: true },
      { name: 'enchant_value', type: 'INTEGER', nullable: true, default: 0 },
      { name: 'food_nutrition', type: 'INTEGER', nullable: true },
      { name: 'food_saturation', type: 'REAL', nullable: true },
      { name: 'food_always_eat', type: 'INTEGER', nullable: true },
      { name: 'default_components_json', type: 'TEXT', nullable: true },
    ],
    indexes: ['CREATE INDEX IF NOT EXISTS idx_items_modid ON items(modid)'],
  },
  {
    name: 'blocks',
    columns: [
      { name: 'block_id', type: 'TEXT', primaryKey: true },
      { name: 'item_id', type: 'TEXT', nullable: true },
      { name: 'hardness', type: 'REAL', nullable: true },
      { name: 'resistance', type: 'REAL', nullable: true },
      { name: 'light_emission', type: 'INTEGER', nullable: true },
      { name: 'requires_correct_tool', type: 'INTEGER', nullable: true },
      { name: 'sound_type', type: 'TEXT', nullable: true },
    ],
    indexes: ['CREATE INDEX IF NOT EXISTS idx_blocks_item_id ON blocks(item_id)'],
  },
  {
    name: 'item_creative_tabs',
    columns: [
      { name: 'item_id', type: 'TEXT', nullable: false },
      { name: 'tab_id', type: 'TEXT', nullable: false },
    ],
    constraints: ['PRIMARY KEY(item_id, tab_id)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_item_creative_tabs_item_id ON item_creative_tabs(item_id)',
      'CREATE INDEX IF NOT EXISTS idx_item_creative_tabs_tab_id ON item_creative_tabs(tab_id)',
    ],
  },
  {
    name: 'item_tags',
    columns: [
      { name: 'tag_id', type: 'TEXT', nullable: false },
      { name: 'item_id', type: 'TEXT', nullable: false },
    ],
    constraints: ['PRIMARY KEY(tag_id, item_id)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_item_tags_item_id ON item_tags(item_id)',
      'CREATE INDEX IF NOT EXISTS idx_item_tags_tag_id ON item_tags(tag_id)',
    ],
  },
  {
    name: 'recipes',
    columns: [
      { name: 'recipe_id', type: 'TEXT', primaryKey: true },
      { name: 'type_id', type: 'TEXT', nullable: false },
      { name: 'modid', type: 'TEXT', nullable: false },
      { name: 'hash', type: 'TEXT', nullable: false },
      { name: 'raw_json', type: 'TEXT', nullable: true },
      { name: 'unparsed', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'group', type: 'TEXT', nullable: true },
      { name: 'input_width', type: 'INTEGER', nullable: true },
      { name: 'input_height', type: 'INTEGER', nullable: true },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_recipes_type_id ON recipes(type_id)',
      'CREATE INDEX IF NOT EXISTS idx_recipes_modid ON recipes(modid)',
    ],
  },
  {
    name: 'recipe_inputs',
    columns: [
      { name: 'recipe_id', type: 'TEXT', nullable: false },
      { name: 'slot', type: 'INTEGER', nullable: false },
      { name: 'role', type: 'TEXT', nullable: false },
      { name: 'kind', type: 'TEXT', nullable: false },
      { name: 'ref', type: 'TEXT', nullable: true },
      { name: 'count', type: 'INTEGER', nullable: false, default: 1 },
    ],
    constraints: ['PRIMARY KEY(recipe_id, slot, role, kind, ref)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_recipe_inputs_ref ON recipe_inputs(kind, ref)',
      'CREATE INDEX IF NOT EXISTS idx_recipe_inputs_recipe_id ON recipe_inputs(recipe_id)',
    ],
  },
  {
    name: 'recipe_outputs',
    columns: [
      { name: 'recipe_id', type: 'TEXT', nullable: false },
      { name: 'slot', type: 'INTEGER', nullable: false },
      { name: 'item_id', type: 'TEXT', nullable: false },
      { name: 'count', type: 'INTEGER', nullable: false, default: 1 },
      { name: 'components_json', type: 'TEXT', nullable: true },
      { name: 'is_primary', type: 'INTEGER', nullable: false, default: 1 },
    ],
    constraints: ['PRIMARY KEY(recipe_id, slot, item_id)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_recipe_outputs_item_id ON recipe_outputs(item_id)',
      'CREATE INDEX IF NOT EXISTS idx_recipe_outputs_recipe_id ON recipe_outputs(recipe_id)',
    ],
  },
  {
    name: 'translations',
    columns: [
      { name: 'key', type: 'TEXT', nullable: false },
      { name: 'lang', type: 'TEXT', nullable: false },
      { name: 'value', type: 'TEXT', nullable: false },
    ],
    constraints: ['PRIMARY KEY(key, lang)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_translations_lang_value ON translations(lang, value)',
    ],
  },
  {
    name: 'data_imports',
    columns: [
      { name: 'import_id', type: 'TEXT', primaryKey: true },
      { name: 'source_file_path', type: 'TEXT', nullable: false },
      { name: 'source_kind', type: 'TEXT', nullable: false, default: 'legacy_exporter' },
      { name: 'data_version', type: 'TEXT', nullable: false },
      { name: 'schema_version', type: 'TEXT', nullable: false, default: '1.0' },
      { name: 'capabilities_json', type: 'TEXT', nullable: false, default: '{"browse":true,"mvp0_unify":false,"reason":"legacy_export_without_structured_recipes"}' },
      { name: 'modlist_hash', type: 'TEXT', nullable: true },
      { name: 'exported_at', type: 'TEXT', nullable: true },
      { name: 'mod_count', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'item_count', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'recipe_count', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'tag_count', type: 'INTEGER', nullable: false, default: 0 },
      { name: 'imported_at', type: 'TEXT', nullable: false },
      { name: 'is_success', type: 'INTEGER', nullable: false, default: 1 },
      { name: 'error_message', type: 'TEXT', nullable: true },
    ],
  },
  {
    name: 'item_resources',
    columns: [
      { name: 'item_id', type: 'TEXT', nullable: false },
      { name: 'resource_type', type: 'TEXT', nullable: false },
      { name: 'namespace', type: 'TEXT', nullable: false },
      { name: 'path', type: 'TEXT', nullable: false },
      { name: 'content', type: 'TEXT', nullable: true },
    ],
    constraints: ['PRIMARY KEY(item_id, resource_type, namespace, path)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_item_resources_item_id ON item_resources(item_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_item_resources_pk ON item_resources(item_id, resource_type, namespace, path)',
    ],
  },
  {
    name: 'recipe_views',
    columns: [
      { name: 'type_id', type: 'TEXT', primaryKey: true },
      { name: 'layout_json', type: 'TEXT', nullable: false },
      { name: 'base64_png', type: 'TEXT', nullable: true },
      { name: 'version', type: 'INTEGER', nullable: true },
    ],
  },
  {
    name: 'recipe_view_backgrounds',
    columns: [
      { name: 'type_id', type: 'TEXT', primaryKey: true },
      { name: 'png', type: 'BLOB', nullable: false },
      { name: 'sha1', type: 'TEXT', nullable: false },
    ],
  },
  {
    // 契约 v2：战利品表最终态原始 JSON（exporter 事实）
    name: 'loot_tables',
    columns: [
      { name: 'loot_table_id', type: 'TEXT', primaryKey: true },
      { name: 'json', type: 'TEXT', nullable: false },
    ],
  },
  {
    // 契约 v2：方块/实体 → 战利品表精确绑定（exporter 事实）
    name: 'loot_bindings',
    columns: [
      { name: 'kind', type: 'TEXT', nullable: false },
      { name: 'source_id', type: 'TEXT', nullable: false },
      { name: 'loot_table_id', type: 'TEXT', nullable: false },
    ],
    constraints: ['PRIMARY KEY(kind, source_id)'],
    indexes: ['CREATE INDEX IF NOT EXISTS idx_loot_bindings_table ON loot_bindings(loot_table_id)'],
  },
  {
    // 导入时派生物化：物品 → 获取来源（见 mod-data-importer/loot-sources.ts）
    name: 'item_loot_sources',
    columns: [
      { name: 'item_id', type: 'TEXT', nullable: false },
      { name: 'category', type: 'TEXT', nullable: false },
      { name: 'source_id', type: 'TEXT', nullable: false },
      { name: 'loot_table_id', type: 'TEXT', nullable: false },
      { name: 'occurrences_json', type: 'TEXT', nullable: false },
    ],
    constraints: ['PRIMARY KEY(item_id, category, source_id, loot_table_id)'],
    indexes: ['CREATE INDEX IF NOT EXISTS idx_item_loot_sources_item ON item_loot_sources(item_id)'],
  },
  {
    name: 'plans',
    columns: [
      { name: 'plan_id', type: 'TEXT', primaryKey: true },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'action', type: 'TEXT', nullable: false },
      { name: 'params_json', type: 'TEXT', nullable: false },
      { name: 'created_at', type: 'TEXT', nullable: false },
      { name: 'updated_at', type: 'TEXT', nullable: false },
      { name: 'notes', type: 'TEXT', nullable: true },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_plans_updated_at ON plans(updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_plans_action ON plans(action)',
    ],
  },
  {
    name: 'plan_snapshots',
    columns: [
      { name: 'snapshot_id', type: 'TEXT', primaryKey: true },
      { name: 'plan_id', type: 'TEXT', nullable: false },
      { name: 'result_json', type: 'TEXT', nullable: false },
      { name: 'generated_files_json', type: 'TEXT', nullable: true },
      { name: 'created_at', type: 'TEXT', nullable: false },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_plan_snapshots_plan_id ON plan_snapshots(plan_id)',
      'CREATE INDEX IF NOT EXISTS idx_plan_snapshots_created_at ON plan_snapshots(created_at)',
    ],
  },
  {
    // 导入时派生物化：游戏事实图谱节点（见 services/graph/derive.ts）
    name: 'graph_nodes',
    columns: [
      { name: 'node_id', type: 'TEXT', primaryKey: true },
      { name: 'node_type', type: 'TEXT', nullable: false },
      { name: 'modid', type: 'TEXT', nullable: true },
      { name: 'display', type: 'TEXT', nullable: true },
      { name: 'extra_json', type: 'TEXT', nullable: true },
    ],
    indexes: ['CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type)'],
  },
  {
    // 导入时派生物化：游戏事实图谱边（见 services/graph/derive.ts）
    name: 'graph_edges',
    columns: [
      { name: 'edge_id', type: 'TEXT', primaryKey: true },
      { name: 'from_node_id', type: 'TEXT', nullable: false },
      { name: 'relation', type: 'TEXT', nullable: false },
      { name: 'to_node_id', type: 'TEXT', nullable: false },
      { name: 'weight', type: 'REAL', nullable: true },
      { name: 'evidence', type: 'TEXT', nullable: true },
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id)',
      'CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id)',
      'CREATE INDEX IF NOT EXISTS idx_graph_edges_relation ON graph_edges(relation)',
    ],
  },
  {
    name: 'item_embeddings',
    columns: [
      { name: 'item_id', type: 'TEXT', primaryKey: true },
      { name: 'model', type: 'TEXT', nullable: false },
      { name: 'dim', type: 'INTEGER', nullable: false },
      { name: 'vector', type: 'BLOB', nullable: false },
      { name: 'source_text', type: 'TEXT', nullable: false },
      { name: 'source_hash', type: 'TEXT', nullable: false },
      { name: 'updated_at', type: 'TEXT', nullable: false },
    ],
  },
  {
    name: 'embedding_meta',
    columns: [
      { name: 'key', type: 'TEXT', primaryKey: true },
      { name: 'value', type: 'TEXT', nullable: false },
    ],
  },
];

// 扩展字段表（用于存储从 manifest 或其他来源动态添加的字段）
export interface ExtendedField {
  tableName: string;
  columnName: string;
  columnType: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  defaultValue?: string | number;
  source: string; // 来源标记（如 'manifest', 'user_defined' 等）
}

// ============================================================================
// Schema Manager 类
// ============================================================================

export class SchemaManager {
  private client: Client;
  private extendedFields: ExtendedField[] = [];

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 初始化数据库 - 创建所有核心表
   */
  async initialize(): Promise<void> {
    console.log('[SchemaManager] Initializing database...');

    for (const table of CORE_TABLES) {
      await this.createTableIfNotExists(table);
    }

    // 初始化 schema_version
    await this.client.execute(`
      INSERT OR IGNORE INTO schema_version (version) VALUES (1)
    `);

    // 创建扩展字段追踪表
    await this.createExtendedFieldsTable();

    // 迁移已存在的表结构（修复约束问题）
    await this.migrateExistingTables();

    console.log('[SchemaManager] Database initialized');
  }

  /**
   * 根据 manifest 自动扩展表结构
   * 读取 manifest 中的字段定义，自动添加到对应表
   */
  async extendFromManifest(): Promise<void> {
    try {
      const manifestResult = await this.client.execute('SELECT key, value FROM manifest');
      const manifest = new Map(
        manifestResult.rows.map(row => [row.key as string, row.value as string])
      );

      // 检查 manifest 中是否有扩展字段定义
      const extendedFieldsJson = manifest.get('extended_fields');
      if (extendedFieldsJson) {
        const fields: ExtendedField[] = JSON.parse(extendedFieldsJson);
        for (const field of fields) {
          await this.addColumnIfNotExists(field);
        }
      }

      // 根据 manifest 中的 known_fields 自动添加缺失的列
      const knownFieldsJson = manifest.get('known_fields');
      if (knownFieldsJson) {
        const knownFields: Array<{ table: string; field: string; type: string }> = 
          JSON.parse(knownFieldsJson);
        
        for (const { table, field, type } of knownFields) {
          await this.addColumnIfNotExists({
            tableName: table,
            columnName: field,
            columnType: this.mapSqlType(type),
            source: 'manifest_auto',
          });
        }
      }
    } catch (error) {
      console.warn('[SchemaManager] Failed to extend from manifest:', error);
    }
  }

  /**
   * 动态添加列（如果不存在）
   */
  async addColumnIfNotExists(field: ExtendedField): Promise<void> {
    try {
      // 检查列是否已存在
      const columnExists = await this.checkColumnExists(field.tableName, field.columnName);
      if (columnExists) {
        return;
      }

      // 构建 ALTER TABLE 语句
      const nullable = field.defaultValue === undefined ? '' : 'NOT NULL';
      const defaultClause = field.defaultValue !== undefined 
        ? `DEFAULT ${formatDefaultValue(field.defaultValue)}`
        : '';

      const sql = `ALTER TABLE ${quoteIdentifier(field.tableName)} ADD COLUMN ${quoteIdentifier(field.columnName)} ${field.columnType} ${nullable} ${defaultClause}`.trim();
      
      await this.client.execute(sql);
      console.log(`[SchemaManager] Added column: ${field.tableName}.${field.columnName}`);

      // 记录到扩展字段表
      await this.recordExtendedField(field);
    } catch (error) {
      console.error(`[SchemaManager] Failed to add column ${field.tableName}.${field.columnName}:`, error);
      throw error;
    }
  }

  /**
   * 获取数据库当前 schema 信息
   */
  async getCurrentSchema(): Promise<{ tables: string[]; columns: Record<string, string[]> }> {
    const tables: string[] = [];
    const columns: Record<string, string[]> = {};

    try {
      // 获取所有表
      const tablesResult = await this.client.execute(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `);
      
      for (const row of tablesResult.rows) {
        const tableName = row.name as string;
        tables.push(tableName);

        // 获取表的所有列
        const columnsResult = await this.client.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        columns[tableName] = columnsResult.rows.map((col: unknown) => {
          const c = col as { name: string };
          return c.name;
        });
      }
    } catch (error) {
      console.error('[SchemaManager] Failed to get schema:', error);
    }

    return { tables, columns };
  }

  /**
   * 验证数据库结构完整性
   */
  async validateSchema(): Promise<{ valid: boolean; missingTables: string[]; missingColumns: Array<{ table: string; column: string }> }> {
    const currentSchema = await this.getCurrentSchema();
    const missingTables: string[] = [];
    const missingColumns: Array<{ table: string; column: string }> = [];

    // 检查核心表
    for (const tableDef of CORE_TABLES) {
      if (!currentSchema.tables.includes(tableDef.name)) {
        missingTables.push(tableDef.name);
        continue;
      }

      // 检查表的列
      const tableColumns = currentSchema.columns[tableDef.name] || [];
      for (const colDef of tableDef.columns) {
        // 转换列名（处理下划线/驼峰转换）
        const possibleNames = [
          colDef.name,
          colDef.name.replace(/_/g, ''), // 移除下划线
          colDef.name.replace(/([A-Z])/g, '_$1').toLowerCase(), // 驼峰转下划线
        ];
        
        const exists = possibleNames.some(name => tableColumns.includes(name));
        if (!exists) {
          missingColumns.push({ table: tableDef.name, column: colDef.name });
        }
      }
    }

    return {
      valid: missingTables.length === 0 && missingColumns.length === 0,
      missingTables,
      missingColumns,
    };
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 迁移已存在的表结构
   * 修复已有表的约束问题（如 NOT NULL 限制）
   */
  private async migrateExistingTables(): Promise<void> {
    console.log('[SchemaManager] Migrating existing tables...');

    for (const table of CORE_TABLES) {
      try {
        // 检查表是否存在
        const tableExists = await this.checkTableExists(table.name);
        if (!tableExists) {
          console.log(`[SchemaManager] Table ${table.name} does not exist yet, skipping migration`);
          continue;
        }
        
        console.log(`[SchemaManager] Checking table ${table.name} for migration...`);

        // 获取表的当前列信息
        const columnsResult = await this.client.execute(`PRAGMA table_info(${quoteIdentifier(table.name)})`);
        const existingColumns = new Map(
          columnsResult.rows.map((row: unknown) => {
            const r = row as { name: string; notnull: number; dflt_value: string | null };
            return [r.name, { notNull: r.notnull === 1, defaultValue: r.dflt_value }];
          })
        );

        // 检查需要修复的列
        for (const colDef of table.columns) {
          const existingCol = existingColumns.get(colDef.name);
          if (!existingCol) {
            // 列不存在，添加新列
            await this.addColumnToTable(table.name, colDef);
            continue;
          }

          // 检查约束是否需要修复
          const shouldBeNullable = colDef.nullable !== false;
          const isCurrentlyNotNull = existingCol.notNull;

          if (shouldBeNullable && isCurrentlyNotNull && !colDef.primaryKey) {
            // 需要将 NOT NULL 改为 NULLABLE
            console.log(`[SchemaManager] Fixing constraint for ${table.name}.${colDef.name}: removing NOT NULL`);
            await this.recreateTableWithFixedConstraints(table);
            break; // 重建表后跳出，继续下一个表
          }
        }
      } catch (error) {
        console.warn(`[SchemaManager] Migration warning for ${table.name}:`, error);
      }
    }

    console.log('[SchemaManager] Table migration completed');
  }

  /**
   * 添加列到已存在的表
   */
  private async addColumnToTable(tableName: string, colDef: ColumnDef): Promise<void> {
    try {
      const nullable = colDef.nullable === false ? 'NOT NULL' : '';
      const defaultClause = colDef.default !== undefined 
        ? `DEFAULT ${formatDefaultValue(colDef.default)}`
        : '';

      const sql = `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(colDef.name)} ${colDef.type} ${nullable} ${defaultClause}`.trim();
      await this.client.execute(sql);
      console.log(`[SchemaManager] Added column: ${tableName}.${colDef.name}`);
    } catch (error) {
      // 列可能已存在，忽略错误
      if ((error as Error).message?.includes('duplicate column')) {
        console.log(`[SchemaManager] Column already exists: ${tableName}.${colDef.name}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * 重建表以修复约束
   * SQLite 不支持直接修改列约束，需要重建表
   */
  private async recreateTableWithFixedConstraints(table: TableDef): Promise<void> {
    const tempTableName = `${table.name}_temp`;

    console.log(`[SchemaManager] Recreating table ${table.name} with fixed constraints...`);

    // 1. 创建临时表（使用正确的约束）
    const columnsSql = table.columns.map(col => {
      let sql = `${quoteIdentifier(col.name)} ${col.type}`;
      if (col.primaryKey) sql += ' PRIMARY KEY';
      if (col.nullable === false && !col.primaryKey) sql += ' NOT NULL';
      if (col.default !== undefined) {
        sql += ` DEFAULT ${formatDefaultValue(col.default)}`;
      }
      return sql;
    });
    const constraintsSql = table.constraints ?? [];
    const tableSql = [...columnsSql, ...constraintsSql].join(', ');

    await this.client.execute(`CREATE TABLE ${quoteIdentifier(tempTableName)} (${tableSql})`);

    // 2. 复制数据
    const columnNames = table.columns.map(col => quoteIdentifier(col.name)).join(', ');
    await this.client.execute(`
      INSERT INTO ${quoteIdentifier(tempTableName)} (${columnNames})
      SELECT ${columnNames} FROM ${quoteIdentifier(table.name)}
    `);

    // 3. 删除旧表
    await this.client.execute(`DROP TABLE ${quoteIdentifier(table.name)}`);

    // 4. 重命名临时表
    await this.client.execute(`ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(table.name)}`);

    // 5. 重建索引
    if (table.indexes) {
      for (const indexSql of table.indexes) {
        await this.client.execute(indexSql);
      }
    }

    console.log(`[SchemaManager] Table ${table.name} recreated successfully`);
  }

  private async checkTableExists(tableName: string): Promise<boolean> {
    try {
      const result = await this.client.execute(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name=?
      `, [tableName]);
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  private async createTableIfNotExists(table: TableDef): Promise<void> {
    const columnsSql = table.columns.map(col => {
      let sql = `${quoteIdentifier(col.name)} ${col.type}`;
      if (col.primaryKey) sql += ' PRIMARY KEY';
      // 只有明确设置 nullable: false 时才添加 NOT NULL
      if (col.nullable === false && !col.primaryKey) sql += ' NOT NULL';
      if (col.default !== undefined) {
        sql += ` DEFAULT ${formatDefaultValue(col.default)}`;
      }
      return sql;
    });
    const constraintsSql = table.constraints ?? [];
    const tableSql = [...columnsSql, ...constraintsSql].join(', ');

    const createSql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (${tableSql})`;
    
    await this.client.execute(createSql);

    // 创建索引
    if (table.indexes) {
      for (const indexSql of table.indexes) {
        await this.client.execute(indexSql);
      }
    }
  }

  private async createExtendedFieldsTable(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS _extended_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        column_type TEXT NOT NULL,
        default_value TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(table_name, column_name)
      )
    `);
  }

  private async checkColumnExists(tableName: string, columnName: string): Promise<boolean> {
    try {
      const result = await this.client.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
      return result.rows.some((row: unknown) => {
        const r = row as { name: string };
        return r.name === columnName;
      });
    } catch {
      return false;
    }
  }

  private async recordExtendedField(field: ExtendedField): Promise<void> {
    try {
      await this.client.execute({
        sql: `
          INSERT OR REPLACE INTO _extended_fields 
          (table_name, column_name, column_type, default_value, source, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `,
        args: [
          field.tableName,
          field.columnName,
          field.columnType,
          field.defaultValue?.toString() ?? null,
          field.source,
        ],
      });
    } catch (error) {
      console.warn('[SchemaManager] Failed to record extended field:', error);
    }
  }

  private mapSqlType(type: string): 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' {
    const upperType = type.toUpperCase();
    if (upperType.includes('INT')) return 'INTEGER';
    if (upperType.includes('FLOAT') || upperType.includes('REAL') || upperType.includes('DOUBLE')) return 'REAL';
    if (upperType.includes('BLOB')) return 'BLOB';
    return 'TEXT';
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 SchemaManager 实例
 */
export function createSchemaManager(client: Client): SchemaManager {
  return new SchemaManager(client);
}

/**
 * 快速初始化数据库（包含扩展机制）
 */
export async function initializeDatabaseWithExtensions(client: Client): Promise<void> {
  const manager = createSchemaManager(client);
  await manager.initialize();
  await manager.extendFromManifest();
}
