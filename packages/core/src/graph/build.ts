/**
 * Graph 构建器
 *
 * 从 project.db 读事实表 → deriveGraph → 事务内全量重建 graph_nodes/graph_edges。
 * 导入管线（importer）在事务内直接用 deriveGraph + writeGraph；本模块的
 * rebuildGraph 供 CLI `graph rebuild` 与后续维护入口使用。全量重建幂等。
 */

import { createClient, type Client } from '@libsql/client';
import type {
  ItemEntry,
  ItemLootSourceEntry,
  ItemTagEntry,
  RecipeEntry,
  RecipeInputEntry,
  RecipeOutputEntry,
} from '../mod-data-importer/types';
import { deriveGraph, type DerivedGraph } from './derive';

const BATCH_SIZE = 500;

async function queryAll<T>(client: Client, sql: string): Promise<T[]> {
  const result = await client.execute(sql);
  return result.rows as unknown as T[];
}

/** 从 project.db 读取物品显示名（en_us 优先，缺失退回 translation_key） */
async function loadDisplayNames(client: Client): Promise<Map<string, string>> {
  const rows = await queryAll<{ item_id: string; translation_key: string | null }>(
    client,
    'SELECT item_id, translation_key FROM items WHERE translation_key IS NOT NULL',
  );
  const keys = rows.map(r => r.translation_key).filter((k): k is string => !!k);
  const names = new Map<string, string>();
  if (keys.length === 0) return names;

  const translations = new Map<string, string>();
  // 分块查询避免占位符上限
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const chunk = keys.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await client.execute({
      sql: `SELECT key, value FROM translations WHERE lang = 'en_us' AND key IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows) {
      translations.set(String(row.key), String(row.value));
    }
  }
  for (const row of rows) {
    const value = row.translation_key ? translations.get(row.translation_key) : undefined;
    if (value) names.set(row.item_id, value);
  }
  return names;
}

/** 在调用方事务内全量重写 graph_nodes / graph_edges（多行 INSERT，与 importer 同模式，不用 client.batch——它会在已有事务内再开事务） */
export async function writeGraph(client: Client, graph: DerivedGraph): Promise<void> {
  await client.execute('DELETE FROM graph_edges');
  await client.execute('DELETE FROM graph_nodes');

  for (let i = 0; i < graph.nodes.length; i += BATCH_SIZE) {
    const chunk = graph.nodes.slice(i, i + BATCH_SIZE);
    await client.execute({
      sql: `INSERT INTO graph_nodes (node_id, node_type, modid, display, extra_json) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(',')}`,
      args: chunk.flatMap(node => [node.node_id, node.node_type, node.modid, node.display, node.extra_json]),
    });
  }
  for (let i = 0; i < graph.edges.length; i += BATCH_SIZE) {
    const chunk = graph.edges.slice(i, i + BATCH_SIZE);
    await client.execute({
      sql: `INSERT INTO graph_edges (edge_id, from_node_id, relation, to_node_id, weight, evidence) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(',')}`,
      args: chunk.flatMap(edge => [edge.edge_id, edge.from_node_id, edge.relation, edge.to_node_id, edge.weight, edge.evidence]),
    });
  }
}

export interface RebuildGraphResult {
  nodeCount: number;
  edgeCount: number;
  edgesByRelation: Record<string, number>;
}

/** 从 project.db 事实表全量重建图谱（CLI graph rebuild 用） */
export async function rebuildGraph(projectDbPath: string): Promise<RebuildGraphResult> {
  const client = createClient({ url: `file:${projectDbPath}` });
  try {
    const [items, tags, recipes, recipeInputs, recipeOutputs, lootSources, displayNames] =
      await Promise.all([
        queryAll<ItemEntry>(client, 'SELECT * FROM items'),
        queryAll<ItemTagEntry>(client, 'SELECT * FROM item_tags'),
        queryAll<RecipeEntry>(client, 'SELECT * FROM recipes'),
        queryAll<RecipeInputEntry>(client, 'SELECT * FROM recipe_inputs'),
        queryAll<RecipeOutputEntry>(client, 'SELECT * FROM recipe_outputs'),
        queryAll<ItemLootSourceEntry>(client, 'SELECT * FROM item_loot_sources'),
        loadDisplayNames(client),
      ]);

    // recipes.unparsed 在库里是 0/1
    const normalizedRecipes = recipes.map(r => ({ ...r, unparsed: !!r.unparsed }));
    const graph = deriveGraph({
      items,
      tags,
      recipes: normalizedRecipes,
      recipeInputs,
      recipeOutputs,
      lootSources,
      displayNames,
    });

    await client.execute('BEGIN');
    try {
      await writeGraph(client, graph);
      await client.execute('COMMIT');
    } catch (error) {
      await client.execute('ROLLBACK').catch(() => {});
      throw error;
    }

    const edgesByRelation: Record<string, number> = {};
    for (const edge of graph.edges) {
      edgesByRelation[edge.relation] = (edgesByRelation[edge.relation] ?? 0) + 1;
    }
    return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, edgesByRelation };
  } finally {
    client.close();
  }
}
