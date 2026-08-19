/**
 * did_you_mean 的打分，纯函数。不碰 IO，便于将来接测试。
 *
 * 不用模型：编辑距离 + 后缀/子串，可复现。embedding 是另一条检索路，
 * 缺 id 时不能把「编一个看起来像的」再交给向量碰运气。
 */

export type SuggestReason = 'exact_suffix' | 'substring' | 'edit_distance';

export interface ScoredId {
  id: string;
  query: string;
  score: number;
  reason: SuggestReason;
}

export const DEFAULT_SUGGEST_LIMIT = 5;
export const MAX_SUGGEST_LIMIT = 20;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 8) return Math.max(a.length, b.length);

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** 去掉 node 前缀后的裸 id，以及最后一段 path（minecraft:copper_ingot → copper_ingot） */
export function idParts(raw: string): { bare: string; path: string; namespace: string | null } {
  let bare = raw;
  for (const prefix of ['item:', 'tag:', 'recipe:', 'loot:'] as const) {
    if (bare.startsWith(prefix)) {
      bare = bare.slice(prefix.length);
      break;
    }
  }
  const slash = Math.max(bare.lastIndexOf('/'), bare.lastIndexOf(':'));
  if (slash < 0) return { bare, path: bare, namespace: null };
  return { bare, path: bare.slice(slash + 1), namespace: bare.slice(0, slash) };
}

/**
 * 对单个候选打分。对不上返回 null（调用方丢掉）。
 * 分数 0–1，越大越像。
 */
export function scoreCandidate(query: string, candidate: string): Omit<ScoredId, 'id' | 'query'> | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) return { score: 1, reason: 'exact_suffix' };

  const qParts = idParts(q);
  const cParts = idParts(c);

  if (c === qParts.bare || c.endsWith(`:${qParts.bare}`) || c.endsWith(`/${qParts.bare}`)) {
    return { score: 0.98, reason: 'exact_suffix' };
  }
  if (cParts.path === qParts.path && qParts.path.length > 0) {
    return { score: 0.95, reason: 'exact_suffix' };
  }

  if (qParts.bare.length >= 3 && c.includes(qParts.bare)) {
    const extra = Math.max(0, c.length - qParts.bare.length);
    return { score: Math.max(0.62, 0.9 - extra * 0.008), reason: 'substring' };
  }
  if (qParts.path.length >= 3 && cParts.path.includes(qParts.path)) {
    return { score: 0.72, reason: 'substring' };
  }

  if (qParts.path.length >= 4) {
    const dist = levenshtein(qParts.path, cParts.path);
    const maxLen = Math.max(qParts.path.length, cParts.path.length, 1);
    if (dist <= 2 || dist / maxLen <= 0.35) {
      const sameNs = qParts.namespace && qParts.namespace === cParts.namespace ? 0.05 : 0;
      return { score: Math.max(0, 0.82 - dist / maxLen + sameNs), reason: 'edit_distance' };
    }
  }
  return null;
}

function kindPrefix(id: string): string {
  for (const prefix of ['item:', 'tag:', 'recipe:', 'loot:'] as const) {
    if (id.startsWith(prefix)) return prefix;
  }
  return '';
}

export function rankSuggestions(
  query: string,
  candidates: readonly string[],
  limit: number,
): { suggestions: ScoredId[]; scored: number } {
  const seen = new Set<string>();
  const scored: ScoredId[] = [];
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = scoreCandidate(query, id);
    if (!hit) continue;
    scored.push({ id, query, ...hit });
  }
  const want = kindPrefix(query);
  scored.sort((a, b) => {
    const aKind = want && kindPrefix(a.id) === want ? 1 : 0;
    const bKind = want && kindPrefix(b.id) === want ? 1 : 0;
    if (bKind !== aKind) return bKind - aKind;
    return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { suggestions: scored.slice(0, limit), scored: scored.length };
}
