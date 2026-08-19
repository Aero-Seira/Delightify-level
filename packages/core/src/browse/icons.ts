/**
 * 浏览层：物品图标。
 *
 * `item_resources.content` 存的是 PNG 的 base64。这里解成字节，让 HTTP 层直接发
 * `image/png`：一屏两百个图标走浏览器自己的图片缓存，比 IDE 那样每个图标一次
 * JSON+base64 往返省一个数量级。
 */

import type { Client } from '@libsql/client';
import { createHash } from 'node:crypto';

export interface ItemIconPng {
  bytes: Uint8Array;
  /** 内容哈希，直接当 ETag 用 */
  etag: string;
}

const DATA_URL_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

/** 去掉 node id 前缀与 data URL 头，返回裸 base64；无内容则 null */
export function normalizeIconContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  return trimmed.replace(DATA_URL_PREFIX, '');
}

export function bareItemId(itemId: string): string {
  if (itemId.startsWith('item:')) return itemId.slice('item:'.length);
  if (itemId.startsWith('tag:')) return itemId.slice('tag:'.length);
  return itemId;
}

export async function loadItemIconPng(client: Client, itemId: string): Promise<ItemIconPng | null> {
  let content: string | null = null;
  try {
    const result = await client.execute({
      sql: `SELECT content FROM item_resources
            WHERE item_id = ? AND resource_type = 'texture' AND content IS NOT NULL
            LIMIT 1`,
      args: [bareItemId(itemId)],
    });
    const row = result.rows[0];
    content = row?.content == null ? null : String(row.content);
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  const base64 = normalizeIconContent(content);
  if (!base64) return null;

  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (bytes.length === 0) return null;

  const etag = createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  return { bytes, etag };
}

/** 哪些物品有图标，用于列表一次性判断，避免逐个 404 */
export async function itemsWithIcons(
  client: Client,
  itemIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (itemIds.length === 0) return found;
  try {
    for (let i = 0; i < itemIds.length; i += 500) {
      const chunk = itemIds.slice(i, i + 500).map(bareItemId);
      const placeholders = chunk.map(() => '?').join(',');
      const result = await client.execute({
        sql: `SELECT DISTINCT item_id FROM item_resources
              WHERE resource_type = 'texture' AND content IS NOT NULL
                AND item_id IN (${placeholders})`,
        args: chunk,
      });
      for (const row of result.rows) found.add(String(row.item_id));
    }
  } catch (error) {
    if (isMissingTable(error)) return found;
    throw error;
  }
  return found;
}
