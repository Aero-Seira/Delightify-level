/**
 * Embedding source_text 组装
 *
 * 每个物品的嵌入文本：中文名 / 英文名 | item_id | mod 名 | 主要 tag。
 * 纯函数，便于 smoke 断言；文本原样存入 item_embeddings.source_text 可审计。
 */

export interface ItemTextFacts {
  itemId: string;
  modid: string;
  /** zh_cn 显示名（可缺） */
  nameZh?: string | null;
  /** en_us 显示名（可缺） */
  nameEn?: string | null;
  /** mod 显示名（可缺） */
  modName?: string | null;
  /** 所属 tag id 列表 */
  tags?: string[];
}

/** source_text 中最多携带的 tag 数（避免长 tag 列表稀释语义） */
const MAX_TAGS_IN_TEXT = 8;

export function buildSourceText(facts: ItemTextFacts): string {
  const names = [facts.nameZh, facts.nameEn]
    .filter((v, i, arr): v is string => !!v && arr.indexOf(v) === i)
    .join(' / ');
  const parts = [names || facts.itemId, facts.itemId, facts.modName || facts.modid];
  const tags = (facts.tags ?? []).slice(0, MAX_TAGS_IN_TEXT);
  if (tags.length > 0) {
    parts.push(`tags: ${tags.join(', ')}`);
  }
  return parts.join(' | ');
}
