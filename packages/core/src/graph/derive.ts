/**
 * Graph 派生器
 *
 * 从已导入的游戏事实（items / item_tags / recipe_inputs / recipe_outputs /
 * item_loot_sources）派生「游戏事实图谱」（graph_nodes / graph_edges）。
 *
 * 设计要点：
 *  - 与 loot-sources.ts 同一原则：exporter 只存事实，图谱是纯派生，
 *    旧快照重新导入或 `graph rebuild` 即可获得/刷新图谱，无需重跑游戏内导出。
 *  - 节点四类：item / tag / recipe / loot_source；边四类：
 *    member_of（item→tag）、input_of（item/tag→recipe）、
 *    output_of（item→recipe）、obtained_from（item→loot_source）。
 *  - tag 输入双重表示：保留 tag→recipe 边，同时展开为成员物品→recipe 边
 *    （evidence 记来源 tag），方便按物品直接查用途。
 *  - 与知识 Agent 的 knowledge_edges（模组级知识图谱）层级不同，互不写入。
 */

import type {
  ItemEntry,
  ItemLootSourceEntry,
  ItemTagEntry,
  RecipeEntry,
  RecipeInputEntry,
  RecipeOutputEntry,
} from '../mod-data-importer/types';

export type GraphNodeType = 'item' | 'tag' | 'recipe' | 'loot_source';
export type GraphRelation = 'member_of' | 'input_of' | 'output_of' | 'obtained_from';

export interface GraphNodeRow {
  node_id: string;
  node_type: GraphNodeType;
  modid: string | null;
  display: string | null;
  extra_json: string | null;
}

export interface GraphEdgeRow {
  edge_id: string;
  from_node_id: string;
  relation: GraphRelation;
  to_node_id: string;
  weight: number | null;
  evidence: string | null;
}

export interface DerivedGraph {
  nodes: GraphNodeRow[];
  edges: GraphEdgeRow[];
}

export interface DeriveGraphInput {
  items: ItemEntry[];
  tags: ItemTagEntry[];
  recipes: RecipeEntry[];
  recipeInputs: RecipeInputEntry[];
  recipeOutputs: RecipeOutputEntry[];
  lootSources: ItemLootSourceEntry[];
  /** item_id -> 显示名（通常取 en_us 翻译），可缺省 */
  displayNames?: ReadonlyMap<string, string>;
}

export function itemNodeId(itemId: string): string {
  return `item:${itemId}`;
}

export function tagNodeId(tagId: string): string {
  return `tag:${tagId}`;
}

export function recipeNodeId(recipeId: string): string {
  return `recipe:${recipeId}`;
}

export function lootNodeId(category: string, sourceId: string): string {
  return `loot:${category}:${sourceId}`;
}

function namespaceOf(id: string): string | null {
  const at = id.indexOf(':');
  return at > 0 ? id.slice(0, at) : null;
}

/**
 * 派生图谱（纯函数）。
 * 输入表任一为空都安全；同一 (from, relation, to) 只保留一条边。
 */
export function deriveGraph(input: DeriveGraphInput): DerivedGraph {
  const nodes = new Map<string, GraphNodeRow>();
  const edges = new Map<string, GraphEdgeRow>();

  const ensureNode = (row: GraphNodeRow): void => {
    const existing = nodes.get(row.node_id);
    if (!existing) {
      nodes.set(row.node_id, row);
      return;
    }
    // 已存在时只补缺字段（事实表里的条目优先于引用产生的存根）
    if (!existing.display && row.display) existing.display = row.display;
    if (!existing.extra_json && row.extra_json) existing.extra_json = row.extra_json;
  };

  const addEdge = (
    fromNodeId: string,
    relation: GraphRelation,
    toNodeId: string,
    evidence: string | null = null,
    weight: number | null = null,
  ): void => {
    const edgeId = `${fromNodeId}|${relation}|${toNodeId}`;
    if (edges.has(edgeId)) return;
    edges.set(edgeId, {
      edge_id: edgeId,
      from_node_id: fromNodeId,
      relation,
      to_node_id: toNodeId,
      weight,
      evidence,
    });
  };

  // ── 物品节点 ────────────────────────────────────────────────
  for (const item of input.items) {
    ensureNode({
      node_id: itemNodeId(item.item_id),
      node_type: 'item',
      modid: item.modid,
      display: input.displayNames?.get(item.item_id) ?? null,
      extra_json: JSON.stringify({ is_block: item.is_block ?? 0 }),
    });
  }

  // ── tag 节点 + member_of 边 ─────────────────────────────────
  const tagMembers = new Map<string, string[]>();
  for (const row of input.tags) {
    ensureNode({
      node_id: tagNodeId(row.tag_id),
      node_type: 'tag',
      modid: namespaceOf(row.tag_id),
      display: row.tag_id,
      extra_json: null,
    });
    // 引用了未导入物品的，补存根节点
    ensureNode({
      node_id: itemNodeId(row.item_id),
      node_type: 'item',
      modid: namespaceOf(row.item_id),
      display: input.displayNames?.get(row.item_id) ?? null,
      extra_json: null,
    });
    addEdge(itemNodeId(row.item_id), 'member_of', tagNodeId(row.tag_id));
    const members = tagMembers.get(row.tag_id);
    if (members) members.push(row.item_id);
    else tagMembers.set(row.tag_id, [row.item_id]);
  }

  // ── 配方节点 ────────────────────────────────────────────────
  for (const recipe of input.recipes) {
    ensureNode({
      node_id: recipeNodeId(recipe.recipe_id),
      node_type: 'recipe',
      modid: recipe.modid,
      display: recipe.recipe_id,
      extra_json: JSON.stringify({ type_id: recipe.type_id, unparsed: recipe.unparsed ? 1 : 0 }),
    });
  }

  // ── input_of 边（item/tag → recipe；tag 输入同时展开成员物品） ──
  for (const row of input.recipeInputs) {
    if (!row.ref) continue;
    const recipeId = recipeNodeId(row.recipe_id);
    ensureNode({
      node_id: recipeId,
      node_type: 'recipe',
      modid: namespaceOf(row.recipe_id),
      display: row.recipe_id,
      extra_json: null,
    });
    if (row.kind === 'tag') {
      ensureNode({
        node_id: tagNodeId(row.ref),
        node_type: 'tag',
        modid: namespaceOf(row.ref),
        display: row.ref,
        extra_json: null,
      });
      addEdge(tagNodeId(row.ref), 'input_of', recipeId);
      for (const member of tagMembers.get(row.ref) ?? []) {
        ensureNode({
          node_id: itemNodeId(member),
          node_type: 'item',
          modid: namespaceOf(member),
          display: input.displayNames?.get(member) ?? null,
          extra_json: null,
        });
        addEdge(itemNodeId(member), 'input_of', recipeId, `tag:${row.ref}`);
      }
    } else if (row.kind === 'item') {
      ensureNode({
        node_id: itemNodeId(row.ref),
        node_type: 'item',
        modid: namespaceOf(row.ref),
        display: input.displayNames?.get(row.ref) ?? null,
        extra_json: null,
      });
      addEdge(itemNodeId(row.ref), 'input_of', recipeId);
    }
    // 其他 kind（fluid 等）当前契约不出现，忽略
  }

  // ── output_of 边（item → recipe） ───────────────────────────
  for (const row of input.recipeOutputs) {
    const recipeId = recipeNodeId(row.recipe_id);
    ensureNode({
      node_id: recipeId,
      node_type: 'recipe',
      modid: namespaceOf(row.recipe_id),
      display: row.recipe_id,
      extra_json: null,
    });
    ensureNode({
      node_id: itemNodeId(row.item_id),
      node_type: 'item',
      modid: namespaceOf(row.item_id),
      display: input.displayNames?.get(row.item_id) ?? null,
      extra_json: null,
    });
    addEdge(itemNodeId(row.item_id), 'output_of', recipeId, null, row.count ?? null);
  }

  // ── loot_source 节点 + obtained_from 边 ─────────────────────
  for (const row of input.lootSources) {
    const lootId = lootNodeId(row.category, row.source_id);
    ensureNode({
      node_id: lootId,
      node_type: 'loot_source',
      modid: null,
      display: row.source_id,
      extra_json: JSON.stringify({ category: row.category }),
    });
    ensureNode({
      node_id: itemNodeId(row.item_id),
      node_type: 'item',
      modid: namespaceOf(row.item_id),
      display: input.displayNames?.get(row.item_id) ?? null,
      extra_json: null,
    });
    addEdge(itemNodeId(row.item_id), 'obtained_from', lootId, row.loot_table_id);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
