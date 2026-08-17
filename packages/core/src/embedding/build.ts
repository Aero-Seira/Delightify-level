/**
 * Embedding 构建器
 *
 * 显式触发（CLI `embed build`），不进导入管线、不自动上传——
 * source_text 会发给 provider，遵循知识 Agent 的隐私原则。
 *
 * 增量策略：source_hash（sha1(source_text)）未变的物品跳过；
 * embedding_meta.model 与当前模型不一致时全量重建；
 * items 表中已不存在的物品行会被清理。
 */

import * as crypto from 'crypto';
import type { Client } from '@libsql/client';
import { buildSourceText, type ItemTextFacts } from './text';

/** 与 LLMService.embed 对齐的函数形态，便于 smoke 注入 mock */
export type EmbedFn = (texts: string[]) => Promise<{ model: string; vectors: number[][] }>;

const EMBED_BATCH = 64;

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  // 注意按字节对齐拷贝，避免直接 view 共享 Buffer 池的非对齐偏移
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

async function loadItemFacts(client: Client): Promise<ItemTextFacts[]> {
  const items = await client.execute('SELECT item_id, modid, translation_key FROM items');
  const mods = await client.execute('SELECT modid, name FROM mods');
  const modNames = new Map(mods.rows.map(r => [String(r.modid), r.name ? String(r.name) : null]));

  const keys = items.rows.map(r => r.translation_key).filter((k): k is string => !!k);
  const names = new Map<string, { zh?: string; en?: string }>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await client.execute({
      sql: `SELECT key, lang, value FROM translations WHERE lang IN ('zh_cn','en_us') AND key IN (${placeholders})`,
      args: chunk,
    });
    for (const row of rows.rows) {
      const entry = names.get(String(row.key)) ?? {};
      if (row.lang === 'zh_cn') entry.zh = String(row.value);
      else entry.en = String(row.value);
      names.set(String(row.key), entry);
    }
  }

  const tagRows = await client.execute('SELECT tag_id, item_id FROM item_tags');
  const tagsByItem = new Map<string, string[]>();
  for (const row of tagRows.rows) {
    const list = tagsByItem.get(String(row.item_id));
    if (list) list.push(String(row.tag_id));
    else tagsByItem.set(String(row.item_id), [String(row.tag_id)]);
  }

  return items.rows.map(row => {
    const itemId = String(row.item_id);
    const key = row.translation_key ? String(row.translation_key) : null;
    const entry = key ? names.get(key) : undefined;
    return {
      itemId,
      modid: String(row.modid),
      nameZh: entry?.zh ?? null,
      nameEn: entry?.en ?? null,
      modName: modNames.get(String(row.modid)) ?? null,
      tags: tagsByItem.get(itemId) ?? [],
    };
  });
}

export interface BuildEmbeddingsResult {
  model: string;
  dim: number;
  total: number;
  embedded: number;
  skipped: number;
  pruned: number;
  fullRebuild: boolean;
}

export async function buildEmbeddings(client: Client, embed: EmbedFn): Promise<BuildEmbeddingsResult> {
  // 解析当前模型（空输入不发请求，只走模型解析路径）
  const { model } = await embed([]);

  const metaRows = await client.execute("SELECT key, value FROM embedding_meta WHERE key IN ('model')");
  const previousModel = metaRows.rows.find(r => r.key === 'model')?.value;
  const fullRebuild = previousModel !== undefined && String(previousModel) !== model;

  const facts = await loadItemFacts(client);
  const existing = await client.execute('SELECT item_id, source_hash FROM item_embeddings');
  const existingHash = new Map(existing.rows.map(r => [String(r.item_id), String(r.source_hash)]));

  const pending: Array<{ facts: ItemTextFacts; text: string; hash: string }> = [];
  let skipped = 0;
  for (const item of facts) {
    const text = buildSourceText(item);
    const hash = sha1(text);
    if (!fullRebuild && existingHash.get(item.itemId) === hash) {
      skipped++;
      continue;
    }
    pending.push({ facts: item, text, hash });
  }

  // 清理 items 中已不存在的物品行
  const currentIds = new Set(facts.map(f => f.itemId));
  let pruned = 0;
  for (const itemId of existingHash.keys()) {
    if (!currentIds.has(itemId)) {
      await client.execute({ sql: 'DELETE FROM item_embeddings WHERE item_id = ?', args: [itemId] });
      pruned++;
    }
  }

  const now = new Date().toISOString();
  let dim = 0;
  let embedded = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const chunk = pending.slice(i, i + EMBED_BATCH);
    const { vectors } = await embed(chunk.map(c => c.text));
    if (vectors.length !== chunk.length) {
      throw new Error(`embed returned ${vectors.length}/${chunk.length} vectors`);
    }
    for (let j = 0; j < chunk.length; j++) {
      const vector = vectors[j];
      if (dim === 0) dim = vector.length;
      if (vector.length !== dim) {
        throw new Error(`inconsistent vector dim: expected ${dim}, got ${vector.length} (${chunk[j].facts.itemId})`);
      }
      await client.execute({
        sql: 'INSERT OR REPLACE INTO item_embeddings (item_id, model, dim, vector, source_text, source_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [chunk[j].facts.itemId, model, dim, vectorToBlob(vector), chunk[j].text, chunk[j].hash, now],
      });
      embedded++;
    }
  }

  // 全量跳过（无变化）时从已有行读 dim
  if (dim === 0) {
    const row = await client.execute('SELECT dim FROM item_embeddings LIMIT 1');
    dim = row.rows.length > 0 ? Number(row.rows[0].dim) : 0;
  }

  await client.execute({ sql: "INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('model', ?)", args: [model] });
  await client.execute({ sql: "INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('dim', ?)", args: [String(dim)] });
  await client.execute({ sql: "INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('built_at', ?)", args: [now] });

  return { model, dim, total: facts.length, embedded, skipped, pruned, fullRebuild };
}
