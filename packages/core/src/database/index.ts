/**
 * Database Service Layer - v2.1
 * 
 * 统一导出数据库相关的所有模块
 * 支持动态 schema 扩展
 * 
 * @example
 * ```ts
 * import { createProjectDbClient, schema, eq } from '@delightify/main/services/database';
 * 
 * const db = createProjectDbClient(projectDbPath);
 * const result = await db.execute('SELECT * FROM mods');
 * ```
 */

// Schema definitions
export * from './schema';

// Schema manager (动态扩展)
export {
  SchemaManager,
  createSchemaManager,
  initializeDatabaseWithExtensions,
  CORE_TABLES,
  type ColumnDef,
  type TableDef,
  type ExtendedField,
} from './schema-manager';

// Client factories
export {
  createProjectDbClient,
  closeProjectDbClient,
  closeAllConnections,
  clearDbCache,
  schema,
  eq, and, or, like, desc, asc, sql, count,
  type ProjectDbClient,
} from './client';

// Re-export drizzle operators for convenience
export { 
  eq as eqOp, 
  ne, 
  gt, 
  gte, 
  lt, 
  lte, 
  like as likeOp, 
  inArray, 
  and as andOp, 
  or as orOp, 
  not, 
  desc as descOp, 
  asc as ascOp, 
  sql as sqlOp,
  count as countOp,
} from 'drizzle-orm';
