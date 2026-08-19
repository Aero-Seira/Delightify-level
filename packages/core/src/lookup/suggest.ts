/**
 * id 是否存在，以及不存在时的 did_you_mean。
 * 只走 SQL + 编辑距离，不调用模型。
 */

import type { Client } from '@libsql/client';
import {
  DEFAULT_SUGGEST_LIMIT,
  MAX_SUGGEST_LIMIT,
  idParts,
  rankSuggestions,
  type ScoredId,
} from './score';

export type LookupKind = 'item' | 'tag' | 'recipe' | 'node';

export interface LookupOptions {
  kinds?: readonly LookupKind[];
  limit?: number;
}

export interface LookupResult {
  query: string;
  exists: boolean;
  /** 库里的规范 id（物品是裸 id，节点带前缀） */
  canonical: string | null;
  suggestions: ScoredId[];
  truncated?: { returned: number; total: number; by: 'suggest_limit' };
}

export class IdNotFoundError extends Error {
  readonly name = 'IdNotFoundError';
  readonly query: string;
  readonly didYouMean: ScoredId[];
  readonly truncated?: LookupResult['truncated'];

  constructor(message: string, result: Pick<LookupResult, 'query' | 'suggestions' | 'truncated'>) {
    super(message);
    this.query = result.query;
    this.didYouMean = result.suggestions;
    this.truncated = result.truncated;
  }
}

const MAX_CANDIDATES = 500;
/** 形状召回单独封顶：它比词干召回宽，不能挤掉词干那一路的名额 */
const MAX_SHAPE_CANDIDATES = 300;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_SUGGEST_LIMIT;
  return Math.min(Math.floor(value), MAX_SUGGEST_LIMIT);
}

/** LIKE 里 % 是任意串。id 里的 _ 留下当单字符通配，正好还能对上 copper_ingot。 */
function safeLikeFragment(value: string): string {
  return value.replace(/%/g, '');
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

async function existsIn(
  client: Client,
  sql: string,
  args: Array<string | number>,
): Promise<boolean> {
  try {
    const result = await client.execute({ sql, args });
    return result.rows.length > 0;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

function rowId(row: Record<string, unknown>): string | null {
  const value = row.id ?? row.item_id ?? row.tag_id ?? row.recipe_id ?? row.node_id;
  return value == null ? null : String(value);
}

async function selectIds(client: Client, sql: string, args: Array<string | number>): Promise<string[]> {
  try {
    const result = await client.execute({ sql, args });
    const ids = result.rows
      .map(row => rowId(row as unknown as Record<string, unknown>))
      .filter((id): id is string => Boolean(id));
    return ids;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

export async function idExists(
  client: Client,
  raw: string,
  kinds: readonly LookupKind[],
): Promise<{ exists: boolean; canonical: string | null }> {
  const { bare } = idParts(raw);
  const nodeId = raw.startsWith('item:') || raw.startsWith('tag:') || raw.startsWith('recipe:') || raw.startsWith('loot:')
    ? raw
    : `item:${bare}`;

  for (const kind of kinds) {
    if (kind === 'item' && (await existsIn(client, 'SELECT 1 AS id FROM items WHERE item_id = ? LIMIT 1', [bare]))) {
      return { exists: true, canonical: bare };
    }
    if (kind === 'tag' && (await existsIn(client, 'SELECT 1 AS id FROM item_tags WHERE tag_id = ? LIMIT 1', [bare]))) {
      return { exists: true, canonical: bare };
    }
    if (kind === 'recipe' && (await existsIn(client, 'SELECT 1 AS id FROM recipes WHERE recipe_id = ? LIMIT 1', [bare]))) {
      return { exists: true, canonical: bare };
    }
    if (kind === 'node' && (await existsIn(client, 'SELECT 1 AS id FROM graph_nodes WHERE node_id = ? LIMIT 1', [nodeId]))) {
      return { exists: true, canonical: nodeId };
    }
  }
  return { exists: false, canonical: null };
}

function tableOf(kind: LookupKind): { column: string; from: string; distinct: string } {
  const column = kind === 'item' ? 'item_id' : kind === 'tag' ? 'tag_id' : kind === 'recipe' ? 'recipe_id' : 'node_id';
  const from = kind === 'item'
    ? 'items'
    : kind === 'tag'
      ? 'item_tags'
      : kind === 'recipe'
        ? 'recipes'
        : 'graph_nodes';
  return { column, from, distinct: kind === 'tag' ? 'DISTINCT ' : '' };
}

/**
 * 形状召回：首字母相同、长度 ±1 的 path。
 *
 * 词干召回取的是**打错的那个 id** 的前缀，错字落在词干里就永远召不回正确答案
 * （whaet 的词干 wha 对不上 wheat）。换位和替换不改长度、极少改首字母，所以
 * 用 `_` 单字符通配按形状再捞一轮，交给编辑距离去筛。
 */
function shapeSqls(kind: LookupKind, query: string): Array<{ sql: string; args: Array<string | number> }> {
  const { path, namespace } = idParts(query);
  if (path.length < 4) return [];
  const first = safeLikeFragment(path.slice(0, 1));
  if (!first || first === '_') return [];

  const { column, from, distinct } = tableOf(kind);
  const specs: Array<{ sql: string; args: Array<string | number> }> = [];

  const shapes: string[] = [];
  for (const len of [path.length - 1, path.length, path.length + 1]) {
    if (len < 3) continue;
    shapes.push(first + '_'.repeat(len - 1));
  }
  if (shapes.length === 0) return [];

  // 命名空间锚定的一路单独查，避免在宽召回的 LIMIT 里被字典序挤掉
  if (namespace) {
    const clauses = shapes.map(() => `${column} LIKE ?`);
    specs.push({
      sql: `SELECT ${distinct}${column} AS id FROM ${from} WHERE ${clauses.join(' OR ')} ORDER BY ${column} LIMIT ?`,
      args: [...shapes.map(shape => `${namespace}:${shape}`), MAX_SHAPE_CANDIDATES],
    });
  }

  // 跨命名空间：path 前可能是 : 或 /，两种都要
  const anchored = shapes.flatMap(shape => [`%:${shape}`, `%/${shape}`]);
  const clauses = anchored.map(() => `${column} LIKE ?`);
  specs.push({
    sql: `SELECT ${distinct}${column} AS id FROM ${from} WHERE ${clauses.join(' OR ')} ORDER BY ${column} LIMIT ?`,
    args: [...anchored, MAX_SHAPE_CANDIDATES],
  });

  return specs;
}

function candidateSql(kind: LookupKind, query: string): { sql: string; args: Array<string | number> } | null {
  const { bare, path, namespace } = idParts(query);
  const fragment = safeLikeFragment(path.length >= 3 ? path : bare);
  if (!fragment) return null;

  const suffix = `%:${fragment}`;
  const contains = `%${fragment}%`;
  const stemLen = path.length <= 5 ? Math.min(3, path.length) : Math.min(6, path.length);
  const stem = safeLikeFragment(path.slice(0, Math.max(3, stemLen)));
  const stemLike = stem.length >= 3 ? `%${stem}%` : null;
  const nsStem = namespace && stem.length >= 3 ? `%${namespace}:${stem}%` : null;

  const { column, from, distinct } = tableOf(kind);
  const exact = kind === 'node'
    ? (query.startsWith('item:') || query.startsWith('tag:') || query.startsWith('recipe:') || query.startsWith('loot:')
      ? query
      : `item:${bare}`)
    : bare;

  const clauses = [`${column} = ?`, `${column} LIKE ?`, `${column} LIKE ?`];
  const args: Array<string | number> = [exact, suffix, contains];
  if (stemLike) {
    clauses.push(`${column} LIKE ?`);
    args.push(stemLike);
  }
  if (nsStem) {
    clauses.push(`${column} LIKE ?`);
    args.push(nsStem);
  }
  args.push(MAX_CANDIDATES);

  return {
    sql: `SELECT ${distinct}${column} AS id FROM ${from}
          WHERE ${clauses.join(' OR ')}
          ORDER BY ${column} LIMIT ?`,
    args,
  };
}

/** 查 id：存在则 exists=true；否则带 suggestions。 */
export async function lookupId(
  client: Client,
  raw: string,
  options: LookupOptions = {},
): Promise<LookupResult> {
  const query = raw.trim();
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : (['item'] as LookupKind[]);
  const limit = clampLimit(options.limit);
  const found = await idExists(client, query, kinds);
  if (found.exists) {
    return { query, exists: true, canonical: found.canonical, suggestions: [] };
  }

  const ids: string[] = [];
  for (const kind of kinds) {
    const spec = candidateSql(kind, query);
    if (spec) ids.push(...(await selectIds(client, spec.sql, spec.args)));
    for (const shape of shapeSqls(kind, query)) {
      ids.push(...(await selectIds(client, shape.sql, shape.args)));
    }
  }

  const ranked = rankSuggestions(query, ids, limit);
  return {
    query,
    exists: false,
    canonical: null,
    suggestions: ranked.suggestions,
    truncated: ranked.scored > ranked.suggestions.length
      ? { returned: ranked.suggestions.length, total: ranked.scored, by: 'suggest_limit' }
      : undefined,
  };
}

export async function requireId(
  client: Client,
  raw: string,
  options: LookupOptions & { label?: string } = {},
): Promise<string> {
  const result = await lookupId(client, raw, options);
  if (result.exists && result.canonical) return result.canonical;
  const label = options.label ?? 'id';
  throw new IdNotFoundError(`${label}不存在：${raw.trim()}`, result);
}

export async function suggestUnknownSeeds(
  client: Client,
  unknown: readonly string[],
): Promise<{ suggestions: ScoredId[]; byQuery: Record<string, ScoredId[]>; truncated?: LookupResult['truncated'] }> {
  const byQuery: Record<string, ScoredId[]> = {};
  const merged: ScoredId[] = [];
  let total = 0;
  for (const seed of unknown) {
    const result = await lookupId(client, seed, { kinds: ['node', 'item', 'tag', 'recipe'] });
    byQuery[seed] = result.suggestions;
    merged.push(...result.suggestions);
    if (result.truncated) total += result.truncated.total;
    else total += result.suggestions.length;
  }
  merged.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const suggestions = merged.slice(0, DEFAULT_SUGGEST_LIMIT);
  return {
    suggestions,
    byQuery,
    truncated: total > suggestions.length
      ? { returned: suggestions.length, total, by: 'suggest_limit' }
      : undefined,
  };
}
