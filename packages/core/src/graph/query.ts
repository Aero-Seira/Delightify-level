/**
 * Graph 查询
 *
 * 供 CLI（scripts/agent-query.mjs）复用的只读查询。
 * 规模假设：节点 ~10⁴–10⁵、边 ~10⁵，逐层 SQL BFS 足够，不做全图内存加载。
 */

import type { Client } from '@libsql/client';
import { itemNodeId, type GraphNodeRow, type GraphRelation } from './derive';

export interface GraphStats {
  nodesByType: Record<string, number>;
  edgesByRelation: Record<string, number>;
  nodeCount: number;
  edgeCount: number;
}

export async function graphStats(client: Client): Promise<GraphStats> {
  const nodeRows = await client.execute('SELECT node_type, COUNT(*) AS n FROM graph_nodes GROUP BY node_type');
  const edgeRows = await client.execute('SELECT relation, COUNT(*) AS n FROM graph_edges GROUP BY relation');
  const nodesByType: Record<string, number> = {};
  const edgesByRelation: Record<string, number> = {};
  let nodeCount = 0;
  let edgeCount = 0;
  for (const row of nodeRows.rows) {
    nodesByType[String(row.node_type)] = Number(row.n);
    nodeCount += Number(row.n);
  }
  for (const row of edgeRows.rows) {
    edgesByRelation[String(row.relation)] = Number(row.n);
    edgeCount += Number(row.n);
  }
  return { nodesByType, edgesByRelation, nodeCount, edgeCount };
}

interface EdgeRow {
  from_node_id: string;
  relation: string;
  to_node_id: string;
  weight: number | null;
  evidence: string | null;
}

async function edgesFrom(client: Client, nodeId: string, relation?: string): Promise<EdgeRow[]> {
  const result = relation
    ? await client.execute({
        sql: 'SELECT from_node_id, relation, to_node_id, weight, evidence FROM graph_edges WHERE from_node_id = ? AND relation = ?',
        args: [nodeId, relation],
      })
    : await client.execute({
        sql: 'SELECT from_node_id, relation, to_node_id, weight, evidence FROM graph_edges WHERE from_node_id = ?',
        args: [nodeId],
      });
  return result.rows as unknown as EdgeRow[];
}

async function edgesTo(client: Client, nodeId: string, relation?: string): Promise<EdgeRow[]> {
  const result = relation
    ? await client.execute({
        sql: 'SELECT from_node_id, relation, to_node_id, weight, evidence FROM graph_edges WHERE to_node_id = ? AND relation = ?',
        args: [nodeId, relation],
      })
    : await client.execute({
        sql: 'SELECT from_node_id, relation, to_node_id, weight, evidence FROM graph_edges WHERE to_node_id = ?',
        args: [nodeId],
      });
  return result.rows as unknown as EdgeRow[];
}

/** 批量补齐节点行（分块 500 避开占位符上限）。closure.ts 复用，不从包外导出。 */
export async function loadNodes(client: Client, nodeIds: readonly string[]): Promise<Map<string, GraphNodeRow>> {
  const map = new Map<string, GraphNodeRow>();
  for (let i = 0; i < nodeIds.length; i += 500) {
    const chunk = nodeIds.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await client.execute({
      sql: `SELECT node_id, node_type, modid, display, extra_json FROM graph_nodes WHERE node_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows as unknown as GraphNodeRow[]) {
      map.set(row.node_id, row);
    }
  }
  return map;
}

export interface ItemUsages {
  itemId: string;
  display: string | null;
  tags: string[];
  /** 该物品作为输入的配方 id（含经 tag 展开的，evidence 里可见） */
  inputOfRecipes: string[];
  /** 产出该物品的配方 id */
  outputOfRecipes: string[];
  obtainedFrom: Array<{ category: string | null; sourceId: string | null; lootTableId: string | null }>;
}

/** 物品用途聚合：所属 tag / 作为输入 / 作为产出 / 获取来源 */
export async function itemUsages(client: Client, itemId: string): Promise<ItemUsages> {
  const nodeId = itemNodeId(itemId);
  const out = await edgesFrom(client, nodeId);
  const nodes = await loadNodes(client, [nodeId]);

  const tags: string[] = [];
  const inputOfRecipes = new Set<string>();
  const outputOfRecipes = new Set<string>();
  const obtainedFrom: ItemUsages['obtainedFrom'] = [];

  for (const edge of out) {
    if (edge.relation === 'member_of') {
      tags.push(edge.to_node_id.slice('tag:'.length));
    } else if (edge.relation === 'input_of') {
      inputOfRecipes.add(edge.to_node_id.slice('recipe:'.length));
    } else if (edge.relation === 'output_of') {
      outputOfRecipes.add(edge.to_node_id.slice('recipe:'.length));
    } else if (edge.relation === 'obtained_from') {
      // loot:<category>:<sourceId>
      const rest = edge.to_node_id.slice('loot:'.length);
      const at = rest.indexOf(':');
      obtainedFrom.push({
        category: at >= 0 ? rest.slice(0, at) : null,
        sourceId: at >= 0 ? rest.slice(at + 1) : rest,
        lootTableId: edge.evidence,
      });
    }
  }

  return {
    itemId,
    display: nodes.get(nodeId)?.display ?? null,
    tags: tags.sort(),
    inputOfRecipes: [...inputOfRecipes].sort(),
    outputOfRecipes: [...outputOfRecipes].sort(),
    obtainedFrom,
  };
}

export interface NeighborsOptions {
  relation?: GraphRelation;
  direction?: 'out' | 'in' | 'both';
  depth?: number; // 1–3
}

export interface NeighborsResult {
  root: string;
  depth: number;
  nodes: GraphNodeRow[];
  edges: EdgeRow[];
  truncated: boolean;
}

const MAX_VISITED = 2000;

/** 从节点出发的 BFS 遍历（防环，深度封顶 3，规模封顶 MAX_VISITED） */
export async function graphNeighbors(
  client: Client,
  nodeId: string,
  options: NeighborsOptions = {},
): Promise<NeighborsResult> {
  const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
  const direction = options.direction ?? 'both';
  const visited = new Set<string>([nodeId]);
  const collectedEdges: EdgeRow[] = [];
  let frontier = [nodeId];
  let truncated = false;

  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next = new Set<string>();
    for (const current of frontier) {
      const outEdges = direction !== 'in' ? await edgesFrom(client, current, options.relation) : [];
      const inEdges = direction !== 'out' ? await edgesTo(client, current, options.relation) : [];
      for (const edge of [...outEdges, ...inEdges]) {
        collectedEdges.push(edge);
        const other = edge.from_node_id === current ? edge.to_node_id : edge.from_node_id;
        if (!visited.has(other)) {
          visited.add(other);
          next.add(other);
          if (visited.size >= MAX_VISITED) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = [...next];
  }

  const nodes = await loadNodes(client, [...visited]);
  return {
    root: nodeId,
    depth,
    nodes: [...nodes.values()],
    edges: collectedEdges,
    truncated,
  };
}

export interface PathResult {
  found: boolean;
  path: Array<{ nodeId: string; relation: string | null }>;
}

/** BFS 最短路径（双向边均视为可走，深度封顶 maxDepth） */
export async function graphPath(
  client: Client,
  fromId: string,
  toId: string,
  maxDepth = 4,
): Promise<PathResult> {
  if (fromId === toId) return { found: true, path: [{ nodeId: fromId, relation: null }] };

  const prev = new Map<string, { from: string; relation: string }>();
  const visited = new Set<string>([fromId]);
  let frontier = [fromId];

  for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      const edges = [...await edgesFrom(client, current), ...await edgesTo(client, current)];
      for (const edge of edges) {
        const other = edge.from_node_id === current ? edge.to_node_id : edge.from_node_id;
        if (visited.has(other)) continue;
        visited.add(other);
        prev.set(other, { from: current, relation: edge.relation });
        if (other === toId) {
          const path: PathResult['path'] = [{ nodeId: toId, relation: null }];
          let cursor = toId;
          while (cursor !== fromId) {
            const step = prev.get(cursor)!;
            path.unshift({ nodeId: step.from, relation: step.relation });
            cursor = step.from;
          }
          return { found: true, path };
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return { found: false, path: [] };
}
