/**
 * scope 成员与编辑的纯函数。与 IO 分离，便于将来接测试。
 *
 * members = (closureNodes ∪ extras) − exclusions
 */

import type { GraphNodeType } from '../graph/derive';
import { nodeTypeOf, normalizeSeedId } from '../graph/closure';
import type { NearMiss } from '../graph/closure';

export const DEFAULT_MEMBERS_LIMIT = 200;
export const SCOPE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface EditSets {
  extras: string[];
  exclusions: string[];
  closureNodes: string[];
}

export interface MemberCounts {
  item: number;
  tag: number;
  recipe: number;
  loot_source: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function assertScopeId(id: string): string {
  if (!SCOPE_ID_PATTERN.test(id)) {
    throw new Error(`scope id 须匹配 ${SCOPE_ID_PATTERN}，收到：${id}`);
  }
  return id;
}

export function computeMembers(
  closureNodes: readonly string[],
  extras: readonly string[],
  exclusions: readonly string[],
): string[] {
  const excluded = new Set(exclusions);
  const members = new Set<string>();
  for (const id of closureNodes) {
    if (!excluded.has(id)) members.add(id);
  }
  for (const id of extras) {
    if (!excluded.has(id)) members.add(id);
  }
  return [...members].sort(compareStrings);
}

export function visibleNearMisses<T extends { nodeId: string }>(
  nearMisses: readonly T[],
  members: readonly string[],
): T[] {
  const memberSet = new Set(members);
  return nearMisses.filter(entry => !memberSet.has(entry.nodeId));
}

export function countByType(members: readonly string[]): MemberCounts {
  const counts: MemberCounts = { item: 0, tag: 0, recipe: 0, loot_source: 0 };
  for (const id of members) {
    const type = nodeTypeOf(id);
    if (type) counts[type] += 1;
  }
  return counts;
}

/** item:minecraft:copper_ingot → minecraft；无法解析则 null */
export function modOfNode(nodeId: string): string | null {
  const rest = nodeId.replace(/^(item|tag|recipe|loot):/, '');
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  return rest.slice(0, colon);
}

export function countItemsByMod(members: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of members) {
    if (nodeTypeOf(id) !== 'item') continue;
    const mod = modOfNode(id) ?? '_';
    counts[mod] = (counts[mod] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareStrings(a, b)));
}

export function groupMembers(
  members: readonly string[],
): { type: GraphNodeType; mod: string | null; ids: string[] }[] {
  const buckets = new Map<string, { type: GraphNodeType; mod: string | null; ids: string[] }>();
  for (const id of members) {
    const type = nodeTypeOf(id);
    if (!type) continue;
    const mod = type === 'item' ? (modOfNode(id) ?? '_') : null;
    const key = `${type}\0${mod ?? ''}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(id);
    else buckets.set(key, { type, mod, ids: [id] });
  }
  return [...buckets.values()].sort(
    (a, b) => compareStrings(a.type, b.type) || compareStrings(a.mod ?? '', b.mod ?? ''),
  );
}

export function applyAdd(sets: EditSets, rawId: string): EditSets {
  const nodeId = normalizeSeedId(rawId);
  const exclusions = sets.exclusions.filter(id => id !== nodeId);
  const extras = sets.closureNodes.includes(nodeId)
    ? sets.extras.filter(id => id !== nodeId)
    : sortedUnique([...sets.extras, nodeId]);
  return { extras, exclusions, closureNodes: sets.closureNodes };
}

export function applyDrop(sets: EditSets, rawId: string): EditSets {
  const nodeId = normalizeSeedId(rawId);
  const members = computeMembers(sets.closureNodes, sets.extras, sets.exclusions);
  if (!members.includes(nodeId)) {
    throw new Error(`不在当前成员里，无法 drop：${nodeId}`);
  }
  return {
    extras: sets.extras.filter(id => id !== nodeId),
    exclusions: sortedUnique([...sets.exclusions, nodeId]),
    closureNodes: sets.closureNodes,
  };
}

export function sliceMembers(
  members: readonly string[],
  limit: number,
): { returned: string[]; truncated?: { returned: number; total: number; by: 'default_limit' } } {
  const cap = !Number.isFinite(limit) || limit < 1 ? DEFAULT_MEMBERS_LIMIT : Math.floor(limit);
  if (members.length <= cap) return { returned: [...members] };
  return {
    returned: members.slice(0, cap),
    truncated: { returned: cap, total: members.length, by: 'default_limit' },
  };
}

export type { NearMiss };
