/**
 * 浏览层：物品查询。
 *
 * 这是**人用的过滤**，不是 docs/design.md §4 的 agent 检索管线：
 * 结果没有 saturated，不能当闭集用。所以不从 agent-query 暴露。
 */

import type { Client } from '@libsql/client';
import { itemUsages, type ItemUsages } from '../graph/query';
import {
  buildItemFilter,
  clampLimit,
  DEFAULT_LANG,
  DEFAULT_LIST_LIMIT,
  FALLBACK_LANG,
  MAX_LIST_LIMIT,
  pagination,
  truncationOf,
  type ItemFilterInput,
  type Truncation,
} from './filters';
import { itemsWithIcons } from './icons';

export interface BrowseItem {
  itemId: string;
  modid: string;
  displayName: string | null;
  isBlock: boolean;
  hasIcon: boolean;
}

export interface BrowseItemsResult {
  items: BrowseItem[];
  total: number;
  page: number;
  pageSize: number;
  truncated?: Truncation;
}

export interface BrowseItemsParams extends ItemFilterInput {
  page?: number | string;
  pageSize?: number | string;
}

export async function browseItems(client: Client, params: BrowseItemsParams): Promise<BrowseItemsResult> {
  const lang = params.lang || DEFAULT_LANG;
  const { page, pageSize, offset } = pagination(params.page, params.pageSize);
  const filter = buildItemFilter({ ...params, lang }, 'items');

  const countResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM items ${filter.where}`,
    args: filter.args,
  });
  const total = Number(countResult.rows[0]?.n ?? 0);

  const rows = await client.execute({
    sql: `
      SELECT items.item_id, items.modid, items.is_block,
             COALESCE(tl.value, te.value) AS display_name
      FROM items
      LEFT JOIN translations tl ON tl.key = items.translation_key AND tl.lang = ?
      LEFT JOIN translations te ON te.key = items.translation_key AND te.lang = ?
      ${filter.where}
      ORDER BY items.item_id
      LIMIT ? OFFSET ?
    `,
    args: [lang, FALLBACK_LANG, ...filter.args, pageSize, offset],
  });

  const icons = await itemsWithIcons(
    client,
    rows.rows.map(row => String(row.item_id)),
  );
  const items = rows.rows.map(row => ({
    itemId: String(row.item_id),
    modid: String(row.modid),
    displayName: row.display_name == null ? null : String(row.display_name),
    isBlock: Boolean(row.is_block),
    hasIcon: icons.has(String(row.item_id)),
  }));

  return {
    items,
    total,
    page,
    pageSize,
    truncated: truncationOf(items.length, total, 'page_size'),
  };
}

export interface FacetEntry {
  value: string;
  count: number;
}

export interface ItemFacets {
  mods: FacetEntry[];
  tags: FacetEntry[];
  truncated?: { mods?: Truncation; tags?: Truncation };
}

/** 分面结果集：取前 limit 组，并用窗口函数在同一次查询里带回真实组数 */
export interface FacetPage {
  entries: FacetEntry[];
  total: number;
}

export function readFacetPage(rows: readonly Record<string, unknown>[]): FacetPage {
  return {
    entries: rows.map(row => ({ value: String(row.value), count: Number(row.n) })),
    total: rows.length > 0 ? Number(rows[0]!.total_groups) : 0,
  };
}

/**
 * mod / tag 两个分面一次算完（IDE 的渲染层是每个 tag 一次查询的 N+1）。
 * 每维排除自身筛选，否则选中后其它值全变 0。
 */
export async function browseItemFacets(
  client: Client,
  params: ItemFilterInput & { limit?: number | string },
): Promise<ItemFacets> {
  const limit = clampLimit(params.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const modFilter = buildItemFilter(params, 'items', 'mod');
  const tagFilter = buildItemFilter(params, 'items', 'tag');

  const [modResult, tagResult] = await Promise.all([
    client.execute({
      sql: `SELECT value, n, COUNT(*) OVER () AS total_groups FROM (
              SELECT items.modid AS value, COUNT(*) AS n FROM items ${modFilter.where}
              GROUP BY items.modid
            ) ORDER BY n DESC, value LIMIT ?`,
      args: [...modFilter.args, limit],
    }),
    client.execute({
      sql: `SELECT value, n, COUNT(*) OVER () AS total_groups FROM (
              SELECT item_tags.tag_id AS value, COUNT(*) AS n
              FROM item_tags JOIN items ON items.item_id = item_tags.item_id
              ${tagFilter.where}
              GROUP BY item_tags.tag_id
            ) ORDER BY n DESC, value LIMIT ?`,
      args: [...tagFilter.args, limit],
    }),
  ]);

  const mods = readFacetPage(modResult.rows as unknown as Record<string, unknown>[]);
  const tags = readFacetPage(tagResult.rows as unknown as Record<string, unknown>[]);

  const truncated: { mods?: Truncation; tags?: Truncation } = {};
  const modTruncation = truncationOf(mods.entries.length, mods.total, 'facet_limit');
  const tagTruncation = truncationOf(tags.entries.length, tags.total, 'facet_limit');
  if (modTruncation) truncated.mods = modTruncation;
  if (tagTruncation) truncated.tags = tagTruncation;

  return {
    mods: mods.entries,
    tags: tags.entries,
    truncated: truncated.mods || truncated.tags ? truncated : undefined,
  };
}

export interface LootOccurrence {
  [key: string]: unknown;
}

/** 浏览层自己的战利品行。不叫 ItemLootSource，避免和 schema 的行类型撞名。 */
export interface BrowseLootSource {
  category: string;
  sourceId: string;
  lootTableId: string;
  sourceName: string | null;
  occurrences: LootOccurrence[];
}

export interface BrowseItemDetail {
  item: BrowseItem | null;
  tags: string[];
  tagsTruncated?: Truncation;
  lootSources: BrowseLootSource[];
  lootTruncated?: Truncation;
  /** 图未构建时为 null，页面据此提示先 graph rebuild */
  usages: ItemUsages | null;
}

const DETAIL_TAG_LIMIT = 200;
const DETAIL_LOOT_LIMIT = 50;

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

export async function browseItemDetail(
  client: Client,
  rawItemId: string,
  options: { lang?: string; usagesLimit?: number } = {},
): Promise<BrowseItemDetail> {
  const itemId = rawItemId.startsWith('item:') ? rawItemId.slice('item:'.length) : rawItemId;
  const lang = options.lang || DEFAULT_LANG;

  const itemResult = await client.execute({
    sql: `
      SELECT items.item_id, items.modid, items.is_block,
             COALESCE(tl.value, te.value) AS display_name
      FROM items
      LEFT JOIN translations tl ON tl.key = items.translation_key AND tl.lang = ?
      LEFT JOIN translations te ON te.key = items.translation_key AND te.lang = ?
      WHERE items.item_id = ?
    `,
    args: [lang, FALLBACK_LANG, itemId],
  });

  const row = itemResult.rows[0];
  const itemIdFound = row ? String(row.item_id) : null;
  const icons = itemIdFound ? await itemsWithIcons(client, [itemIdFound]) : new Set<string>();
  const item = row
    ? {
        itemId: String(row.item_id),
        modid: String(row.modid),
        displayName: row.display_name == null ? null : String(row.display_name),
        isBlock: Boolean(row.is_block),
        hasIcon: icons.has(String(row.item_id)),
      }
    : null;

  const tagResult = await client.execute({
    sql: 'SELECT tag_id FROM item_tags WHERE item_id = ? ORDER BY tag_id',
    args: [itemId],
  });
  const allTags = tagResult.rows.map(r => String(r.tag_id));
  const tags = allTags.slice(0, DETAIL_TAG_LIMIT);

  const lootSources = await loadLootSources(client, itemId, lang);
  const usages = await loadUsages(client, itemId, options.usagesLimit);

  return {
    item,
    tags,
    tagsTruncated: truncationOf(tags.length, allTags.length, 'detail_limit'),
    lootSources: lootSources.slice(0, DETAIL_LOOT_LIMIT),
    lootTruncated: truncationOf(
      Math.min(lootSources.length, DETAIL_LOOT_LIMIT),
      lootSources.length,
      'detail_limit',
    ),
    usages,
  };
}

/** 契约 v2 的派生表；库没升级就当"没有来源数据"，不报错 */
async function loadLootSources(client: Client, itemId: string, lang: string): Promise<BrowseLootSource[]> {
  const sourceKeyExpr = `CASE s.category
    WHEN 'entity' THEN 'entity.' || REPLACE(s.source_id, ':', '.')
    WHEN 'block' THEN 'block.' || REPLACE(s.source_id, ':', '.')
  END`;

  try {
    const result = await client.execute({
      sql: `
        SELECT s.category, s.source_id, s.loot_table_id, s.occurrences_json,
               COALESCE(tl.value, te.value) AS source_name
        FROM item_loot_sources s
        LEFT JOIN translations tl ON tl.key = ${sourceKeyExpr} AND tl.lang = ?
        LEFT JOIN translations te ON te.key = ${sourceKeyExpr} AND te.lang = ?
        WHERE s.item_id = ?
        ORDER BY s.category, s.source_id
      `,
      args: [lang, FALLBACK_LANG, itemId],
    });

    return result.rows.map(row => {
      let occurrences: LootOccurrence[] = [];
      try {
        const parsed = JSON.parse(String(row.occurrences_json));
        if (Array.isArray(parsed)) occurrences = parsed;
      } catch {
        // 损坏的 JSON 按无 occurrence 处理
      }
      return {
        category: String(row.category),
        sourceId: String(row.source_id),
        lootTableId: String(row.loot_table_id),
        sourceName: row.source_name == null ? null : String(row.source_name),
        occurrences,
      };
    });
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

async function loadUsages(
  client: Client,
  itemId: string,
  limit?: number,
): Promise<ItemUsages | null> {
  try {
    return await itemUsages(client, itemId, { limit });
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export interface BrowseModEntry {
  modid: string;
  name: string | null;
  version: string | null;
  itemCount: number;
}

export async function listMods(
  client: Client,
  options: { limit?: number | string } = {},
): Promise<{ mods: BrowseModEntry[]; truncated?: Truncation }> {
  const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const totalResult = await client.execute('SELECT COUNT(*) AS n FROM mods');
  const total = Number(totalResult.rows[0]?.n ?? 0);

  const result = await client.execute({
    sql: `
      SELECT mods.modid, mods.name, mods.version, COUNT(items.item_id) AS n
      FROM mods LEFT JOIN items ON items.modid = mods.modid
      GROUP BY mods.modid ORDER BY mods.modid LIMIT ?
    `,
    args: [limit],
  });

  const mods = result.rows.map(row => ({
    modid: String(row.modid),
    name: row.name == null ? null : String(row.name),
    version: row.version == null ? null : String(row.version),
    itemCount: Number(row.n),
  }));

  return { mods, truncated: truncationOf(mods.length, total, 'list_limit') };
}

export interface TagEntry {
  tagId: string;
  itemCount: number;
}

/** tag 在大包里能上万，所以服务端搜索 + 上限，不像 IDE 那样全量灌进前端 */
export async function listTags(
  client: Client,
  options: { search?: string; limit?: number | string } = {},
): Promise<{ tags: TagEntry[]; truncated?: Truncation }> {
  const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const search = options.search?.trim();
  const where = search ? 'WHERE tag_id LIKE ?' : '';
  const args = search ? [`%${search}%`] : [];

  const totalResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM (SELECT tag_id FROM item_tags ${where} GROUP BY tag_id)`,
    args,
  });
  const total = Number(totalResult.rows[0]?.n ?? 0);

  const result = await client.execute({
    sql: `SELECT tag_id, COUNT(*) AS n FROM item_tags ${where}
          GROUP BY tag_id ORDER BY n DESC, tag_id LIMIT ?`,
    args: [...args, limit],
  });

  const tags = result.rows.map(row => ({
    tagId: String(row.tag_id),
    itemCount: Number(row.n),
  }));

  return { tags, truncated: truncationOf(tags.length, total, 'list_limit') };
}
