/**
 * Loot Sources 派生器
 *
 * 从快照的 loot_tables（最终态原始 JSON）+ loot_bindings + item_tags
 * 派生「物品 → 获取来源」物化视图（item_loot_sources）。
 *
 * 设计要点：
 *  - exporter 只存事实（表 JSON + 精确绑定），派生逻辑放 IDE 侧：
 *    旧快照重新导入即可获得派生能力，无需重跑游戏内导出。
 *  - 嵌套引用（minecraft:loot_table 条目，箱子战利品常用）做记忆化递归解析，防环截断。
 *  - minecraft:tag 条目按最终态 item_tags 展开（expand=true/false 语义都是"该标签物品可产出"）。
 *  - empty / dynamic 条目无物品产出，跳过。
 *  - 来源分类：有绑定的按绑定（block/entity，精确）；无绑定且未被其他表引用的"根表"
 *    按路径约定分类（chests/、gameplay/fishing、archaeology/ 等）。
 */

import type { ItemLootSourceEntry, LootBindingEntry, LootTableEntry } from './types';

/** 单条产出记录：某个 pool 中产出该物品的一次出现 */
export interface LootOccurrence {
  /** pool 在表中的序号 */
  pool: number;
  /** 抽取次数（数字或 {min,max} 等 number provider，原样保留） */
  rolls?: unknown;
  /** set_count 函数的 count（若有，原样保留） */
  count?: unknown;
  /** 生效条件（pool 级 + 条目级原始 condition JSON 合并） */
  conditions: unknown[];
}

/** itemId -> occurrences */
type YieldMap = Map<string, LootOccurrence[]>;

interface NestedRef {
  ref: string;
  conditions: unknown[];
}

interface ParsedTable {
  yields: YieldMap;
  refs: NestedRef[];
}

const COMPOSITE_ENTRY_TYPES = new Set([
  'minecraft:group',
  'minecraft:alternatives',
  'minecraft:sequence',
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 按路径约定分类无绑定的根表。
 * 路径是 vanilla 与 mod 普遍遵守的约定（chests/、entities/ 等）；
 * block/entity 类把 source 还原为注册 ID，其余以表 ID 自身为 source。
 */
export function classifyLootTable(lootTableId: string): { category: string; sourceId: string } {
  const splitAt = lootTableId.indexOf(':');
  const namespace = splitAt >= 0 ? lootTableId.slice(0, splitAt) : 'minecraft';
  const path = splitAt >= 0 ? lootTableId.slice(splitAt + 1) : lootTableId;

  if (path.startsWith('entities/')) return { category: 'entity', sourceId: `${namespace}:${path.slice('entities/'.length)}` };
  if (path.startsWith('blocks/')) return { category: 'block', sourceId: `${namespace}:${path.slice('blocks/'.length)}` };
  if (path.startsWith('chests/')) return { category: 'chest', sourceId: lootTableId };
  if (path === 'gameplay/fishing' || path.startsWith('gameplay/fishing/')) return { category: 'fishing', sourceId: lootTableId };
  if (path === 'gameplay/piglin_bartering') return { category: 'bartering', sourceId: lootTableId };
  if (path.startsWith('archaeology/')) return { category: 'archaeology', sourceId: lootTableId };
  if (path.startsWith('spawners/')) return { category: 'spawner', sourceId: lootTableId };
  if (path.startsWith('dispensers/')) return { category: 'dispenser', sourceId: lootTableId };
  if (path.startsWith('shearing/')) return { category: 'shearing', sourceId: lootTableId };
  if (path.startsWith('pots/')) return { category: 'pot', sourceId: lootTableId };
  if (path.startsWith('gameplay/')) return { category: 'gameplay', sourceId: lootTableId };
  return { category: 'other', sourceId: lootTableId };
}

/** 提取条目上第一个 set_count 函数的 count（数量展示用；无则 undefined） */
function extractSetCount(entry: Record<string, unknown>): unknown {
  for (const fnRaw of asArray(entry.functions)) {
    const fn = asObject(fnRaw);
    if (fn && fn.function === 'minecraft:set_count' && fn.count !== undefined) {
      return fn.count;
    }
  }
  return undefined;
}

interface LeafEmit {
  (kind: 'item' | 'tag' | 'table', ref: string, conditions: unknown[], count: unknown): void;
}

/** 递归展开 composite 条目（group/alternatives/sequence），对叶条目回调 */
function walkEntry(
  entry: Record<string, unknown>,
  inheritedConditions: unknown[],
  emit: LeafEmit,
  depth: number
): void {
  if (depth > 8) return; // 防御异常嵌套数据
  const type = typeof entry.type === 'string' ? entry.type : '';
  const conditions = inheritedConditions.concat(asArray(entry.conditions));

  if (COMPOSITE_ENTRY_TYPES.has(type)) {
    for (const childRaw of asArray(entry.children)) {
      const child = asObject(childRaw);
      if (child) walkEntry(child, conditions, emit, depth + 1);
    }
    return;
  }

  if (type === 'minecraft:item' && typeof entry.name === 'string') {
    emit('item', entry.name, conditions, extractSetCount(entry));
    return;
  }
  if (type === 'minecraft:tag' && typeof entry.name === 'string') {
    emit('tag', entry.name, conditions, extractSetCount(entry));
    return;
  }
  if (type === 'minecraft:loot_table' && typeof entry.value === 'string') {
    emit('table', entry.value, conditions, undefined);
    return;
  }
  // empty / dynamic / 未知类型：无物品产出
}

/** 解析一张表的 JSON：直接产出（tag 已展开）+ 嵌套引用 */
function parseLootTable(json: string, tagMembers: Map<string, string[]>): ParsedTable | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  const table = asObject(root);
  if (!table) return null;

  const yields: YieldMap = new Map();
  const refs: NestedRef[] = [];

  const pushYield = (itemId: string, occurrence: LootOccurrence): void => {
    const existing = yields.get(itemId);
    if (existing) existing.push(occurrence);
    else yields.set(itemId, [occurrence]);
  };

  asArray(table.pools).forEach((poolRaw, poolIndex) => {
    const pool = asObject(poolRaw);
    if (!pool) return;
    const poolConditions = asArray(pool.conditions);
    const rolls = pool.rolls;

    for (const entryRaw of asArray(pool.entries)) {
      const entry = asObject(entryRaw);
      if (!entry) continue;
      walkEntry(entry, poolConditions, (kind, ref, conditions, count) => {
        if (kind === 'table') {
          refs.push({ ref, conditions });
          return;
        }
        const occurrence: LootOccurrence = { pool: poolIndex, conditions };
        if (rolls !== undefined) occurrence.rolls = rolls;
        if (count !== undefined) occurrence.count = count;

        if (kind === 'item') {
          pushYield(ref, occurrence);
        } else {
          // tag 条目：按最终态标签成员展开
          for (const member of tagMembers.get(ref) ?? []) {
            pushYield(member, occurrence);
          }
        }
      }, 0);
    }
  });

  return { yields, refs };
}

function mergeInto(target: YieldMap, source: YieldMap, extraConditions: unknown[]): void {
  for (const [itemId, occurrences] of source) {
    const merged = extraConditions.length === 0
      ? occurrences
      : occurrences.map(occurrence => ({
          ...occurrence,
          conditions: occurrence.conditions.concat(extraConditions),
        }));
    const existing = target.get(itemId);
    if (existing) existing.push(...merged);
    else target.set(itemId, [...merged]);
  }
}

/**
 * 派生物品战利品来源。
 * @param lootTables 快照 loot_tables（原始 JSON）
 * @param bindings   快照 loot_bindings（精确 block/entity 绑定）
 * @param itemTags   最终态 item_tags（tag 条目展开用）
 */
export function deriveItemLootSources(
  lootTables: LootTableEntry[],
  bindings: LootBindingEntry[],
  itemTags: { tag_id: string; item_id: string }[]
): ItemLootSourceEntry[] {
  if (lootTables.length === 0) return [];

  const tagMembers = new Map<string, string[]>();
  for (const { tag_id, item_id } of itemTags) {
    const existing = tagMembers.get(tag_id);
    if (existing) existing.push(item_id);
    else tagMembers.set(tag_id, [item_id]);
  }

  const parsed = new Map<string, ParsedTable | null>();
  for (const table of lootTables) {
    parsed.set(table.loot_table_id, parseLootTable(table.json, tagMembers));
  }

  // 嵌套解析：记忆化 + 防环（环截断为空）
  const resolved = new Map<string, YieldMap>();
  const resolving = new Set<string>();

  const resolveTable = (tableId: string): YieldMap => {
    const cached = resolved.get(tableId);
    if (cached) return cached;
    if (resolving.has(tableId)) return new Map();
    resolving.add(tableId);

    const out: YieldMap = new Map();
    const table = parsed.get(tableId);
    if (table) {
      mergeInto(out, table.yields, []);
      for (const { ref, conditions } of table.refs) {
        // 引用条目上的条件会级联到被引用表的全部产出
        mergeInto(out, resolveTable(ref), conditions);
      }
    }

    resolving.delete(tableId);
    resolved.set(tableId, out);
    return out;
  };

  const boundTableIds = new Set(bindings.map(binding => binding.loot_table_id));
  const referencedTableIds = new Set<string>();
  for (const table of parsed.values()) {
    if (table) {
      for (const { ref } of table.refs) referencedTableIds.add(ref);
    }
  }

  const entries: ItemLootSourceEntry[] = [];
  const seen = new Set<string>();

  const emitRows = (
    itemId: string,
    category: string,
    sourceId: string,
    lootTableId: string,
    occurrences: LootOccurrence[]
  ): void => {
    const key = `${itemId} ${category} ${sourceId} ${lootTableId}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      item_id: itemId,
      category,
      source_id: sourceId,
      loot_table_id: lootTableId,
      occurrences_json: JSON.stringify(occurrences),
    });
  };

  // 1) 精确绑定（block/entity，来自 exporter 运行时捕获）
  for (const binding of bindings) {
    const yields = resolveTable(binding.loot_table_id);
    for (const [itemId, occurrences] of yields) {
      emitRows(itemId, binding.kind, binding.source_id, binding.loot_table_id, occurrences);
    }
  }

  // 2) 无绑定且未被其他表引用的根表：按路径约定分类
  //    （被引用的子表不单独成行，其产出已通过引用方体现）
  for (const [tableId, table] of parsed) {
    if (!table || boundTableIds.has(tableId) || referencedTableIds.has(tableId)) continue;
    const { category, sourceId } = classifyLootTable(tableId);
    const yields = resolveTable(tableId);
    for (const [itemId, occurrences] of yields) {
      emitRows(itemId, category, sourceId, tableId, occurrences);
    }
  }

  entries.sort((a, b) =>
    a.item_id.localeCompare(b.item_id) ||
    a.category.localeCompare(b.category) ||
    a.source_id.localeCompare(b.source_id)
  );
  return entries;
}
