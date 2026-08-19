/**
 * 浏览层的过滤与上限，纯函数。与 IO 分离，便于将来接测试。
 *
 * 条件串只出现一次，count 与 query 共用（IDE 里 items 的 count / query 各写了一份，
 * 改一处漏一处是它已经踩过的坑）。
 */

export type ItemSearchField = 'all' | 'id' | 'name' | 'tag';
export type RecipeSearchField = 'all' | 'id' | 'input' | 'output' | 'json';

export const FALLBACK_LANG = 'en_us';
export const DEFAULT_LANG = 'zh_cn';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** 非分页集合（mods / tags / types / 分面）的默认上限 */
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 2000;

export type SqlArg = string | number;

export interface SqlFilter {
  /** 已含 WHERE，无条件时为空串 */
  where: string;
  args: SqlArg[];
}

export interface Truncation {
  returned: number;
  total: number;
  by: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

/** 落在 [1, max] 内，非法或缺省取 fallback */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = toInt(value);
  if (parsed === null || parsed < 1) return Math.min(fallback, max);
  return Math.min(parsed, max);
}

export function pagination(page: unknown, pageSize: unknown): Pagination {
  const size = clampLimit(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const parsedPage = toInt(page);
  const current = parsedPage === null || parsedPage < 1 ? 1 : parsedPage;
  return { page: current, pageSize: size, offset: (current - 1) * size };
}

/** 超限才有值，用于填响应信封的 truncated（不变量 4.4） */
export function truncationOf(returned: number, total: number, by: string): Truncation | undefined {
  return total > returned ? { returned, total, by } : undefined;
}

function like(value: string): string {
  return `%${value}%`;
}

function combine(conditions: readonly string[], args: readonly SqlArg[]): SqlFilter {
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    args: [...args],
  };
}

export interface ItemFilterInput {
  search?: string;
  searchField?: ItemSearchField;
  lang?: string;
  modid?: string;
  tagId?: string;
}

/**
 * 物品过滤条件。`alias` 是 items 表的别名。
 * `skip` 让分面计数排除自身那一维（算 mod 分面时不按 mod 过滤）。
 */
export function buildItemFilter(
  input: ItemFilterInput,
  alias = 'items',
  skip?: 'mod' | 'tag',
): SqlFilter {
  const conditions: string[] = [];
  const args: SqlArg[] = [];
  const lang = input.lang || DEFAULT_LANG;
  const search = input.search?.trim();

  if (search) {
    const pattern = like(search);
    const byId = `${alias}.item_id LIKE ?`;
    const byName = `${alias}.translation_key IN (SELECT key FROM translations WHERE lang IN (?, ?) AND value LIKE ?)`;
    const byTag = `${alias}.item_id IN (SELECT item_id FROM item_tags WHERE tag_id LIKE ?)`;

    switch (input.searchField ?? 'all') {
      case 'id':
        conditions.push(byId);
        args.push(pattern);
        break;
      case 'name':
        conditions.push(byName);
        args.push(lang, FALLBACK_LANG, pattern);
        break;
      case 'tag':
        conditions.push(byTag);
        args.push(pattern);
        break;
      default:
        conditions.push(`(${byId} OR ${byName} OR ${byTag})`);
        args.push(pattern, lang, FALLBACK_LANG, pattern, pattern);
        break;
    }
  }

  if (input.modid && skip !== 'mod') {
    conditions.push(`${alias}.modid = ?`);
    args.push(input.modid);
  }

  if (input.tagId && skip !== 'tag') {
    conditions.push(`${alias}.item_id IN (SELECT item_id FROM item_tags WHERE tag_id = ?)`);
    args.push(input.tagId);
  }

  return combine(conditions, args);
}

export interface RecipeFilterInput {
  search?: string;
  searchField?: RecipeSearchField;
  modid?: string;
  typeId?: string;
}

/**
 * 配方过滤条件。`alias` 是 recipes 表的别名。
 *
 * 默认搜索走 recipe_inputs(kind, ref) / recipe_outputs(item_id) 的索引；
 * `json` 是全表扫 raw_json 的显式降级选项，不做默认（IDE 把它当默认，大包里很慢）。
 */
export function buildRecipeFilter(
  input: RecipeFilterInput,
  alias = 'recipes',
  skip?: 'mod' | 'type',
): SqlFilter {
  const conditions: string[] = [];
  const args: SqlArg[] = [];
  const search = input.search?.trim();

  if (search) {
    const pattern = like(search);
    const byId = `${alias}.recipe_id LIKE ?`;
    const byInput = `${alias}.recipe_id IN (SELECT recipe_id FROM recipe_inputs WHERE ref LIKE ?)`;
    const byOutput = `${alias}.recipe_id IN (SELECT recipe_id FROM recipe_outputs WHERE item_id LIKE ?)`;
    const byJson = `${alias}.raw_json LIKE ?`;

    switch (input.searchField ?? 'all') {
      case 'id':
        conditions.push(byId);
        args.push(pattern);
        break;
      case 'input':
        conditions.push(byInput);
        args.push(pattern);
        break;
      case 'output':
        conditions.push(byOutput);
        args.push(pattern);
        break;
      case 'json':
        conditions.push(byJson);
        args.push(pattern);
        break;
      default:
        conditions.push(`(${byId} OR ${byInput} OR ${byOutput})`);
        args.push(pattern, pattern, pattern);
        break;
    }
  }

  if (input.modid && skip !== 'mod') {
    conditions.push(`${alias}.modid = ?`);
    args.push(input.modid);
  }

  if (input.typeId && skip !== 'type') {
    conditions.push(`${alias}.type_id = ?`);
    args.push(input.typeId);
  }

  return combine(conditions, args);
}

/** 显示名兜底：minecraft:copper_ingot → Copper Ingot */
export function humanizeId(id: string): string {
  const path = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return path
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
