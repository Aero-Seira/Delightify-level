/**
 * Embedding 检索
 *
 * 暴力余弦相似度：8k 物品 × 1536 维 ≈ 50MB 内存、毫秒级，
 * 当前规模无需 sqlite-vec / ANN 索引（留 TODO，规模上来再评）。
 */

import type { Client } from '@libsql/client';
import { blobToVector, type EmbedFn } from './build';

export interface EmbeddingSearchHit {
  itemId: string;
  score: number;
  sourceText: string;
}

export interface EmbeddingSearchResult {
  model: string | null;
  count: number;
  hits: EmbeddingSearchHit[];
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface StoredRow {
  itemId: string;
  vector: Float32Array;
  sourceText: string;
}

async function loadAll(client: Client): Promise<{ model: string | null; rows: StoredRow[] }> {
  const meta = await client.execute("SELECT value FROM embedding_meta WHERE key = 'model'");
  const model = meta.rows.length > 0 ? String(meta.rows[0].value) : null;
  const result = await client.execute('SELECT item_id, vector, source_text FROM item_embeddings');
  const rows = result.rows.map(row => ({
    itemId: String(row.item_id),
    vector: blobToVector(row.vector as unknown as Uint8Array),
    sourceText: String(row.source_text),
  }));
  return { model, rows };
}

function topK(rows: StoredRow[], query: Float32Array, top: number, excludeId?: string): EmbeddingSearchHit[] {
  const hits: EmbeddingSearchHit[] = [];
  for (const row of rows) {
    if (row.itemId === excludeId) continue;
    if (row.vector.length !== query.length) continue; // 模型切换中途的异维度行跳过
    hits.push({ itemId: row.itemId, score: cosine(query, row.vector), sourceText: row.sourceText });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, top);
}

/** 以查询向量检索（CLI embed search / similar 的公共内核） */
export async function searchByVector(
  client: Client,
  queryVector: number[],
  top = 10,
  excludeItemId?: string,
): Promise<EmbeddingSearchResult> {
  const { model, rows } = await loadAll(client);
  const hits = topK(rows, new Float32Array(queryVector), top, excludeItemId);
  return { model, count: rows.length, hits };
}

/** 以自然语言文本检索（需要 embed 一次查询文本） */
export async function searchByText(
  client: Client,
  embed: EmbedFn,
  text: string,
  top = 10,
): Promise<EmbeddingSearchResult> {
  const { vectors } = await embed([text]);
  if (vectors.length !== 1) {
    throw new Error(`embed returned ${vectors.length} vectors for single query`);
  }
  return searchByVector(client, vectors[0], top);
}

/** 以已有物品检索相似物品 */
export async function searchSimilarItems(
  client: Client,
  itemId: string,
  top = 10,
): Promise<EmbeddingSearchResult> {
  const row = await client.execute({
    sql: 'SELECT vector FROM item_embeddings WHERE item_id = ?',
    args: [itemId],
  });
  if (row.rows.length === 0) {
    throw new Error(`item not embedded: ${itemId}（先运行 embed build）`);
  }
  const vector = blobToVector(row.rows[0].vector as unknown as Uint8Array);
  return searchByVector(client, Array.from(vector), top, itemId);
}
