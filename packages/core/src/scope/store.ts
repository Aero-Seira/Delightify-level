/**
 * scope 持久化。派生表，不进快照。agent-query 直接 createClient，
 * 所以这里自己 CREATE TABLE IF NOT EXISTS，不依赖 SchemaManager。
 */

import type { Client } from '@libsql/client';
import {
  closureFrom,
  normalizeSeedId,
  type ClosureOptions,
  type ClosurePolicyName,
  type ClosureResult,
  type FrontierEntry,
  type NearMiss,
} from '../graph/closure';
import {
  applyAdd,
  applyDrop,
  assertScopeId,
  computeMembers,
  countByType,
  countItemsByMod,
  DEFAULT_MEMBERS_LIMIT,
  sliceMembers,
  visibleNearMisses,
  type MemberCounts,
} from './compute';

export const SCOPE_SOURCE = 'closure';

export interface ScopeCreateInput {
  id: string;
  seeds: readonly string[];
  policy?: ClosurePolicyName;
  maxIterations?: number;
  maxNodes?: number;
  maxFanout?: number;
  nearMissLimit?: number;
}

export interface ScopeShowOptions {
  membersLimit?: number;
}

export interface ScopeSummary {
  id: string;
  policy: ClosurePolicyName;
  status: 'draft' | 'reviewed';
  saturated: boolean | null;
  memberCount: number;
  counts: MemberCounts;
  updatedAt: string;
  reviewedAt: string | null;
  source: string;
}

export interface ScopeView {
  id: string;
  policy: ClosurePolicyName;
  status: 'draft' | 'reviewed';
  saturated: boolean;
  iterations: number;
  limits: ClosureResult['limits'];
  seeds: string[];
  extras: string[];
  exclusions: string[];
  counts: MemberCounts;
  itemCountsByMod: Record<string, number>;
  members: string[];
  frontier: FrontierEntry[];
  nearMisses: NearMiss[];
  computedAt: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  source: string;
  closureTruncated: ClosureResult['truncated'];
  truncated?: { returned: number; total: number; by: 'default_limit' };
}

interface ScopeRow {
  id: string;
  policy: string;
  status: string;
  saturated: number | null;
  iterations: number | null;
  limits_json: string | null;
  truncated_json: string | null;
  frontier_json: string;
  near_misses_json: string;
  closure_nodes_json: string;
  created_at: string;
  updated_at: string;
  computed_at: string | null;
  reviewed_at: string | null;
  source: string;
}

let tablesReady = false;

export async function ensureScopeTables(client: Client): Promise<void> {
  if (tablesReady) return;
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS scopes (
      id TEXT PRIMARY KEY,
      policy TEXT NOT NULL,
      status TEXT NOT NULL,
      saturated INTEGER,
      iterations INTEGER,
      limits_json TEXT,
      truncated_json TEXT,
      frontier_json TEXT NOT NULL,
      near_misses_json TEXT NOT NULL,
      closure_nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      computed_at TEXT,
      reviewed_at TEXT,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scopes_updated_at ON scopes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_scopes_status ON scopes(status);
    CREATE TABLE IF NOT EXISTS scope_seeds (
      scope_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      PRIMARY KEY (scope_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scope_seeds_scope ON scope_seeds(scope_id);
    CREATE TABLE IF NOT EXISTS scope_extras (
      scope_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      source TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scope_extras_scope ON scope_extras(scope_id);
    CREATE TABLE IF NOT EXISTS scope_exclusions (
      scope_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scope_exclusions_scope ON scope_exclusions(scope_id);
  `);
  tablesReady = true;
}

/** 测试或新连接时重置进程内「已建表」缓存 */
export function resetScopeTableCache(): void {
  tablesReady = false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function closureOptions(input: Pick<ScopeCreateInput, 'policy' | 'maxIterations' | 'maxNodes' | 'maxFanout' | 'nearMissLimit'>): ClosureOptions {
  return {
    policy: input.policy,
    maxIterations: input.maxIterations,
    maxNodes: input.maxNodes,
    maxFanout: input.maxFanout,
    nearMissLimit: input.nearMissLimit,
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

async function loadSideTable(client: Client, table: 'scope_seeds' | 'scope_extras' | 'scope_exclusions', scopeId: string): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT node_id FROM ${table} WHERE scope_id = ? ORDER BY node_id`,
    args: [scopeId],
  });
  return result.rows.map(row => String(row.node_id));
}

async function loadRow(client: Client, id: string): Promise<ScopeRow> {
  const result = await client.execute({
    sql: 'SELECT * FROM scopes WHERE id = ?',
    args: [id],
  });
  const row = result.rows[0] as unknown as ScopeRow | undefined;
  if (!row) throw new Error(`scope 不存在：${id}`);
  return row;
}

function viewFromParts(
  row: ScopeRow,
  seeds: string[],
  extras: string[],
  exclusions: string[],
  membersLimit: number,
): ScopeView {
  const closureNodes = parseJson<string[]>(row.closure_nodes_json, []);
  const members = computeMembers(closureNodes, extras, exclusions);
  const sliced = sliceMembers(members, membersLimit);
  const nearMisses = visibleNearMisses(parseJson<NearMiss[]>(row.near_misses_json, []), members);
  return {
    id: row.id,
    policy: row.policy as ClosurePolicyName,
    status: row.status as 'draft' | 'reviewed',
    saturated: row.saturated === 1,
    iterations: row.iterations ?? 0,
    limits: parseJson(row.limits_json, { maxIterations: 0, maxNodes: 0, maxFanout: 0 }),
    seeds,
    extras,
    exclusions,
    counts: countByType(members),
    itemCountsByMod: countItemsByMod(members),
    members: sliced.returned,
    frontier: parseJson<FrontierEntry[]>(row.frontier_json, []),
    nearMisses,
    computedAt: row.computed_at ?? row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    source: row.source,
    closureTruncated: parseJson(row.truncated_json, undefined),
    truncated: sliced.truncated,
  };
}

async function assembleView(client: Client, id: string, membersLimit: number): Promise<ScopeView> {
  const row = await loadRow(client, id);
  const [seeds, extras, exclusions] = await Promise.all([
    loadSideTable(client, 'scope_seeds', id),
    loadSideTable(client, 'scope_extras', id),
    loadSideTable(client, 'scope_exclusions', id),
  ]);
  return viewFromParts(row, seeds, extras, exclusions, membersLimit);
}

async function writeClosureSnapshot(
  client: Client,
  id: string,
  closure: ClosureResult,
  timestamps: { createdAt?: string; reviewedAt?: string | null; status?: string },
): Promise<void> {
  const ts = nowIso();
  await client.execute({
    sql: `INSERT INTO scopes (
      id, policy, status, saturated, iterations, limits_json, truncated_json,
      frontier_json, near_misses_json, closure_nodes_json,
      created_at, updated_at, computed_at, reviewed_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      policy = excluded.policy,
      status = excluded.status,
      saturated = excluded.saturated,
      iterations = excluded.iterations,
      limits_json = excluded.limits_json,
      truncated_json = excluded.truncated_json,
      frontier_json = excluded.frontier_json,
      near_misses_json = excluded.near_misses_json,
      closure_nodes_json = excluded.closure_nodes_json,
      updated_at = excluded.updated_at,
      computed_at = excluded.computed_at,
      reviewed_at = excluded.reviewed_at`,
    args: [
      id,
      closure.policy,
      timestamps.status ?? 'draft',
      closure.saturated ? 1 : 0,
      closure.iterations,
      JSON.stringify(closure.limits),
      closure.truncated ? JSON.stringify(closure.truncated) : null,
      JSON.stringify(closure.frontier),
      JSON.stringify(closure.nearMisses),
      JSON.stringify(closure.nodes),
      timestamps.createdAt ?? ts,
      ts,
      ts,
      timestamps.reviewedAt ?? null,
      SCOPE_SOURCE,
    ],
  });
}

export async function createScope(client: Client, input: ScopeCreateInput): Promise<ScopeView> {
  await ensureScopeTables(client);
  const id = assertScopeId(input.id);
  const existing = await client.execute({ sql: 'SELECT id FROM scopes WHERE id = ?', args: [id] });
  if (existing.rows.length > 0) throw new Error(`scope 已存在：${id}`);
  if (input.seeds.length === 0) throw new Error('scope create 需要至少一个种子');

  const closure = await closureFrom(client, input.seeds, closureOptions(input));
  const createdAt = nowIso();
  await writeClosureSnapshot(client, id, closure, { createdAt, status: 'draft', reviewedAt: null });
  for (const seed of closure.seeds.resolved) {
    await client.execute({
      sql: 'INSERT INTO scope_seeds (scope_id, node_id) VALUES (?, ?)',
      args: [id, seed],
    });
  }
  return assembleView(client, id, DEFAULT_MEMBERS_LIMIT);
}

export async function listScopes(client: Client): Promise<ScopeSummary[]> {
  await ensureScopeTables(client);
  const result = await client.execute(
    'SELECT id, policy, status, saturated, closure_nodes_json, updated_at, reviewed_at, source FROM scopes ORDER BY updated_at DESC, id',
  );
  const summaries: ScopeSummary[] = [];
  for (const raw of result.rows as unknown as Array<Pick<ScopeRow, 'id' | 'policy' | 'status' | 'saturated' | 'closure_nodes_json' | 'updated_at' | 'reviewed_at' | 'source'>>) {
    const [extras, exclusions] = await Promise.all([
      loadSideTable(client, 'scope_extras', raw.id),
      loadSideTable(client, 'scope_exclusions', raw.id),
    ]);
    const members = computeMembers(parseJson<string[]>(raw.closure_nodes_json, []), extras, exclusions);
    summaries.push({
      id: raw.id,
      policy: raw.policy as ClosurePolicyName,
      status: raw.status as 'draft' | 'reviewed',
      saturated: raw.saturated === null ? null : raw.saturated === 1,
      memberCount: members.length,
      counts: countByType(members),
      updatedAt: raw.updated_at,
      reviewedAt: raw.reviewed_at,
      source: raw.source,
    });
  }
  return summaries;
}

export async function showScope(
  client: Client,
  id: string,
  options: ScopeShowOptions = {},
): Promise<ScopeView> {
  await ensureScopeTables(client);
  return assembleView(client, assertScopeId(id), options.membersLimit ?? DEFAULT_MEMBERS_LIMIT);
}

async function replaceEditSet(
  client: Client,
  table: 'scope_extras' | 'scope_exclusions',
  scopeId: string,
  nodeIds: readonly string[],
): Promise<void> {
  await client.execute({ sql: `DELETE FROM ${table} WHERE scope_id = ?`, args: [scopeId] });
  const generatedAt = nowIso();
  for (const nodeId of nodeIds) {
    if (table === 'scope_extras') {
      await client.execute({
        sql: 'INSERT INTO scope_extras (scope_id, node_id, source, generated_at) VALUES (?, ?, ?, ?)',
        args: [scopeId, nodeId, 'author_add', generatedAt],
      });
    } else {
      await client.execute({
        sql: 'INSERT INTO scope_exclusions (scope_id, node_id, generated_at) VALUES (?, ?, ?)',
        args: [scopeId, nodeId, generatedAt],
      });
    }
  }
  await client.execute({
    sql: "UPDATE scopes SET updated_at = ?, status = 'draft', reviewed_at = NULL WHERE id = ?",
    args: [nowIso(), scopeId],
  });
}

async function currentSets(client: Client, id: string) {
  const row = await loadRow(client, id);
  const extras = await loadSideTable(client, 'scope_extras', id);
  const exclusions = await loadSideTable(client, 'scope_exclusions', id);
  return {
    row,
    sets: {
      extras,
      exclusions,
      closureNodes: parseJson<string[]>(row.closure_nodes_json, []),
    },
  };
}

export async function addToScope(client: Client, id: string, nodeId: string): Promise<ScopeView> {
  await ensureScopeTables(client);
  const scopeId = assertScopeId(id);
  const { sets } = await currentSets(client, scopeId);
  const next = applyAdd(sets, nodeId);
  await replaceEditSet(client, 'scope_extras', scopeId, next.extras);
  await replaceEditSet(client, 'scope_exclusions', scopeId, next.exclusions);
  return assembleView(client, scopeId, DEFAULT_MEMBERS_LIMIT);
}

export async function dropFromScope(client: Client, id: string, nodeId: string): Promise<ScopeView> {
  await ensureScopeTables(client);
  const scopeId = assertScopeId(id);
  const { sets } = await currentSets(client, scopeId);
  const next = applyDrop(sets, nodeId);
  await replaceEditSet(client, 'scope_extras', scopeId, next.extras);
  await replaceEditSet(client, 'scope_exclusions', scopeId, next.exclusions);
  return assembleView(client, scopeId, DEFAULT_MEMBERS_LIMIT);
}

export async function recomputeScope(
  client: Client,
  id: string,
  overrides: Pick<ClosureOptions, 'maxIterations' | 'maxNodes' | 'maxFanout' | 'nearMissLimit'> = {},
): Promise<ScopeView> {
  await ensureScopeTables(client);
  const scopeId = assertScopeId(id);
  const row = await loadRow(client, scopeId);
  const seeds = await loadSideTable(client, 'scope_seeds', scopeId);
  if (seeds.length === 0) throw new Error(`scope 没有种子：${scopeId}`);
  const closure = await closureFrom(client, seeds, {
    policy: row.policy as ClosurePolicyName,
    ...overrides,
  });
  await writeClosureSnapshot(client, scopeId, closure, {
    createdAt: row.created_at,
    status: 'draft',
    reviewedAt: null,
  });
  return assembleView(client, scopeId, DEFAULT_MEMBERS_LIMIT);
}

export async function reviewScope(client: Client, id: string): Promise<ScopeView> {
  await ensureScopeTables(client);
  const scopeId = assertScopeId(id);
  await loadRow(client, scopeId);
  const ts = nowIso();
  await client.execute({
    sql: "UPDATE scopes SET status = 'reviewed', reviewed_at = ?, updated_at = ? WHERE id = ?",
    args: [ts, ts, scopeId],
  });
  return assembleView(client, scopeId, DEFAULT_MEMBERS_LIMIT);
}

export async function loadItemIconBase64(client: Client, itemId: string): Promise<string | null> {
  const bare = itemId.startsWith('item:') ? itemId.slice(5) : itemId;
  const result = await client.execute({
    sql: "SELECT content FROM item_resources WHERE item_id = ? AND resource_type = 'texture' AND content IS NOT NULL LIMIT 1",
    args: [bare],
  });
  const content = result.rows[0]?.content;
  return content == null ? null : String(content);
}

export { normalizeSeedId };
