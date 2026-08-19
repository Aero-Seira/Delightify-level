/**
 * Graph 闭包扩张
 *
 * 给定种子节点与关系策略，在游戏事实图谱上分层扩张到不动点，返回闭集、
 * frontier（停在哪、为什么停）与 near_misses（差一点被算进来的是谁）。
 * 目标是消灭「关系性遗漏」：调用方不再需要多次点查询手工拼集合。
 *
 * 设计要点：
 *  - 纯 SQL + 图算法，不调用模型（AGENT.md §4.1）。同输入逐字节同输出：
 *    集合转数组前一律排序，规则分组与来源节点也按固定顺序遍历。
 *  - 策略是纯数据（CLOSURE_POLICIES）+ 纯函数（rulesFor / groupByRule / nodeTypeOf），
 *    与 IO 分离，便于将来接测试。
 *  - 分层同步扩张，每条 (关系, 方向) 规则一条 SQL、id 分块 500。不复用 query.ts 的
 *    逐节点 edgesFrom / edgesTo——闭包会打出几千次往返。
 *  - `saturated` 只在「真正到达不动点且没有任何上限截断」时为 true。调用方拿它
 *    判断「找全了没有」，所以宁可保守报 false，绝不虚报 true。
 *  - 种子豁免 maxFanout（见下方展开循环里的注释）：闭集必须是种子 graph usages
 *    结果的超集，这是核心正确性断言。
 */

import type { Client } from '@libsql/client';
import { IdNotFoundError, suggestUnknownSeeds } from '../lookup/suggest';
import type { ScoredId } from '../lookup/score';
import type { GraphNodeRow, GraphNodeType, GraphRelation } from './derive';
import { loadNodes } from './query';

/** 单条 SQL 的 id 占位符块大小，对齐 loadNodes */
const SQL_CHUNK = 500;
/** frontier 返回上限（AGENT.md §4.4：集合返回必须有上限并自报截断） */
const MAX_FRONTIER = 200;
const DEFAULT_NEAR_MISS_LIMIT = 20;

// ── 策略（纯数据） ──────────────────────────────────────────────

export type ClosurePolicyName = 'recipe-impact' | 'obtainability' | 'same-concept';

/** `out` = 沿 from→to 走，`in` = 沿 to→from 走 */
export type TraversalDirection = 'out' | 'in';

export interface TraversalRule {
  relation: GraphRelation;
  direction: TraversalDirection;
}

export interface PolicyLimits {
  maxIterations: number;
  maxNodes: number;
  /** 单个节点在单条 (关系, 方向) 规则上的边数上限，超过就不展开它，改记 frontier */
  maxFanout: number;
}

export interface PolicySpec {
  rules: Partial<Record<GraphNodeType, TraversalRule[]>>;
  defaults: PolicyLimits;
}

/**
 * 策略必须精确到 (节点类型, 关系, 方向) 三元组，不能笼统地说「走 input_of」。
 * 原因见 derive.ts：tag 类配方输入是**双重表示**——既有 tag→recipe 边，又把
 * tag 的每个成员展开成 item→recipe 边。所以从 recipe **反向**走 input_of 会一次
 * 捞回该配方所有 tag 输入的全部成员物品，再迭代一轮就是全图。
 *
 * 另一处反直觉：`output_of` 的边方向是 item→recipe，「这个配方产出什么」要反向查。
 */
export const CLOSURE_POLICIES: Record<ClosurePolicyName, PolicySpec> = {
  // 「改了这些，什么会受影响」：物品 → 配方 → 产出物 → 再下游
  'recipe-impact': {
    rules: {
      item: [
        { relation: 'member_of', direction: 'out' }, // 它所属的 tag
        { relation: 'input_of', direction: 'out' }, // 消耗它的配方
        { relation: 'output_of', direction: 'out' }, // 产出它的配方
        { relation: 'obtained_from', direction: 'out' }, // 掉落来源
      ],
      tag: [{ relation: 'input_of', direction: 'out' }], // 消耗该 tag 的配方
      // 只反向走 output_of 取产出物。**不反向走 input_of**：配方的其他输入是
      // 「共现」不是「受影响」，走了会经 tag 展开边炸成全图。
      recipe: [{ relation: 'output_of', direction: 'in' }],
      loot_source: [], // 终端
    },
    defaults: { maxIterations: 4, maxNodes: 5000, maxFanout: 200 },
  },

  // 「这些东西怎么获得」：向上游走配料与掉落
  obtainability: {
    rules: {
      item: [
        { relation: 'output_of', direction: 'out' }, // 产出它的配方
        { relation: 'obtained_from', direction: 'out' }, // 掉落来源
      ],
      // 这里**必须**反向走 input_of，要的就是上游配料（item 与 tag 都会回来）；
      // 爆炸风险由 maxFanout 与 maxIterations 压住。
      recipe: [{ relation: 'input_of', direction: 'in' }],
      tag: [{ relation: 'member_of', direction: 'in' }], // tag 成员，受 fanout 限制
      loot_source: [], // 终端
    },
    defaults: { maxIterations: 6, maxNodes: 5000, maxFanout: 100 },
  },

  // 「哪些是同一个东西」：item→tag→item，不进配方
  'same-concept': {
    rules: {
      item: [{ relation: 'member_of', direction: 'out' }],
      tag: [{ relation: 'member_of', direction: 'in' }],
      // 配方与掉落来源不进入闭集：上面两条规则也到不了它们
      recipe: [],
      loot_source: [],
    },
    // maxIterations 默认 2（item→tag→item）。再迭代会经第二层物品的其他 tag
    // 漂移出去，语义就散了。
    defaults: { maxIterations: 2, maxNodes: 1000, maxFanout: 64 },
  },
};

/** 纯函数：某类节点在该策略下可走的规则 */
export function rulesFor(policy: PolicySpec, nodeType: GraphNodeType): TraversalRule[] {
  return policy.rules[nodeType] ?? [];
}

const NODE_TYPE_BY_PREFIX: ReadonlyArray<readonly [string, GraphNodeType]> = [
  ['item:', 'item'],
  ['tag:', 'tag'],
  ['recipe:', 'recipe'],
  ['loot:', 'loot_source'],
];

/**
 * 纯函数：从 node_id 前缀判类型。derive.ts 里每类节点的 id 都由固定前缀构造，
 * 因此这与 graph_nodes.node_type 等价，且省掉逐层回查 graph_nodes 的往返。
 * 前缀不认识时返回 null（正常数据下不会发生），调用处按「终端节点」处理。
 */
export function nodeTypeOf(nodeId: string): GraphNodeType | null {
  for (const [prefix, type] of NODE_TYPE_BY_PREFIX) {
    if (nodeId.startsWith(prefix)) return type;
  }
  return null;
}

/** 纯函数：无前缀的种子按 `item:` 补全（与 agent-query.mjs 的 normalizeNodeId 同规则） */
export function normalizeSeedId(seed: string): string {
  return nodeTypeOf(seed) ? seed : `item:${seed}`;
}

/**
 * 纯函数：把当前层节点按 (关系, 方向) 分组，供批量取边。
 * 不同节点类型可能共享同一条规则（如 recipe-impact 下 item 与 tag 都走 input_of/out），
 * 合并成一条 SQL；fanout 仍按 (来源节点, 规则) 单独判定。
 * 传入的 nodeIds 有序则每组内也有序。
 */
export function groupByRule(
  policy: PolicySpec,
  nodeIds: readonly string[],
): Array<{ rule: TraversalRule; nodes: string[] }> {
  const groups = new Map<string, { rule: TraversalRule; nodes: string[] }>();
  for (const nodeId of nodeIds) {
    const nodeType = nodeTypeOf(nodeId);
    if (!nodeType) continue;
    for (const rule of rulesFor(policy, nodeType)) {
      const key = `${rule.relation}|${rule.direction}`;
      const group = groups.get(key);
      if (group) group.nodes.push(nodeId);
      else groups.set(key, { rule, nodes: [nodeId] });
    }
  }
  return [...groups.keys()].sort().map(key => groups.get(key)!);
}

// ── 返回值契约 ──────────────────────────────────────────────────

export interface ClosureOptions {
  /** 默认 recipe-impact */
  policy?: ClosurePolicyName;
  maxIterations?: number;
  maxNodes?: number;
  maxFanout?: number;
  /** 默认 20，0 = 关闭 */
  nearMissLimit?: number;
  /** 默认 false；true 时附上闭集节点的 graph_nodes 行 */
  includeNodeDetails?: boolean;
}

export interface FrontierEntry {
  nodeId: string;
  nodeType: GraphNodeType;
  reason: 'high_fanout' | 'max_nodes' | 'max_iterations';
  /** high_fanout：该节点在该规则上的边数；其余为 0（未展开，规模未知） */
  wouldAdd: number;
  via: GraphRelation | null;
}

export interface NearMiss {
  nodeId: string;
  nodeType: GraphNodeType;
  display: string | null;
  /** 闭集中与之相邻的**不同节点数** */
  touchedBy: number;
  relations: GraphRelation[];
  why: string;
}

export interface ClosureResult {
  policy: ClosurePolicyName;
  seeds: {
    requested: string[];
    resolved: string[];
    unknown: string[];
    /** 不存在的种子各自的 did_you_mean；没有 unknown 时缺省 */
    didYouMean?: Record<string, ScoredId[]>;
  };
  /** 闭集内各类型节点数 */
  counts: Record<GraphNodeType, number>;
  /** 闭集全部 node_id，按字典序 */
  nodes: string[];
  nodeDetails?: GraphNodeRow[];
  frontier: FrontierEntry[];
  nearMisses: NearMiss[];
  /** 实际执行的扩张层数 */
  iterations: number;
  /** 是否真正到达不动点（任何上限截断都会让它为 false） */
  saturated: boolean;
  /** 回显生效的上限，便于判断结果是不是被自己的参数限死的 */
  limits: PolicyLimits;
  /**
   * 被哪个上限截断了什么。同时命中多个时按严重程度取一个：
   * max_nodes > max_iterations > frontier_limit > near_miss_limit。
   * - max_nodes：returned/total 是闭集节点数
   * - max_iterations：returned/total 是「已展开 / 需展开」的闭集节点数
   * - frontier_limit：returned/total 是 frontier 条目数
   * - near_miss_limit：returned/total 是 near_misses 条目数
   */
  truncated?: {
    returned: number;
    total: number;
    by: 'max_nodes' | 'max_iterations' | 'frontier_limit' | 'near_miss_limit';
  };
}

// ── 批量取边 ────────────────────────────────────────────────────

interface RuleEdge {
  /** 展开的起点（当前层里的那个节点） */
  source: string;
  /** 对端 */
  target: string;
}

/**
 * 按一条 (关系, 方向) 规则批量取边。id 分块 500，一块一条 SQL。
 * direction=out 时 source=from_node_id，direction=in 时 source=to_node_id。
 */
async function edgesForRule(client: Client, rule: TraversalRule, nodeIds: readonly string[]): Promise<RuleEdge[]> {
  // 列名来自固定枚举，非外部输入
  const column = rule.direction === 'out' ? 'from_node_id' : 'to_node_id';
  const edges: RuleEdge[] = [];
  for (let i = 0; i < nodeIds.length; i += SQL_CHUNK) {
    const chunk = nodeIds.slice(i, i + SQL_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await client.execute({
      sql: `SELECT from_node_id, to_node_id FROM graph_edges WHERE relation = ? AND ${column} IN (${placeholders})`,
      args: [rule.relation, ...chunk],
    });
    for (const row of result.rows as unknown as Array<{ from_node_id: string; to_node_id: string }>) {
      edges.push(
        rule.direction === 'out'
          ? { source: row.from_node_id, target: row.to_node_id }
          : { source: row.to_node_id, target: row.from_node_id },
      );
    }
  }
  return edges;
}

// ── 主流程 ──────────────────────────────────────────────────────

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.floor(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 从种子出发做闭包扩张。
 *
 * 种子无前缀时按 `item:` 补全；不存在的种子进 `seeds.unknown` 并继续跑，
 * 仅当全部种子都不存在时抛错。
 */
export async function closureFrom(
  client: Client,
  seeds: readonly string[],
  options: ClosureOptions = {},
): Promise<ClosureResult> {
  const policyName = options.policy ?? 'recipe-impact';
  const spec = CLOSURE_POLICIES[policyName];
  if (!spec) {
    throw new Error(`未知策略：${policyName}（recipe-impact | obtainability | same-concept）`);
  }

  const requested = dedupe(seeds);
  if (requested.length === 0) throw new Error('closureFrom 需要至少一个种子');

  const normalized = dedupe(requested.map(normalizeSeedId));
  const seedRows = await loadNodes(client, normalized);
  const resolved = normalized.filter(id => seedRows.has(id)).sort(compareStrings);
  const unknown = normalized.filter(id => !seedRows.has(id)).sort(compareStrings);
  const unknownSuggestions = unknown.length > 0 ? await suggestUnknownSeeds(client, unknown) : null;
  if (resolved.length === 0) {
    throw new IdNotFoundError(`种子在图谱中均不存在：${unknown.join(', ')}`, {
      query: unknown.join(', '),
      suggestions: unknownSuggestions?.suggestions ?? [],
      truncated: unknownSuggestions?.truncated,
    });
  }

  const limits: PolicyLimits = {
    maxIterations: positiveOr(options.maxIterations, spec.defaults.maxIterations),
    maxNodes: positiveOr(options.maxNodes, spec.defaults.maxNodes),
    maxFanout: positiveOr(options.maxFanout, spec.defaults.maxFanout),
  };
  const nearMissLimit =
    options.nearMissLimit === undefined || !Number.isFinite(options.nearMissLimit) || options.nearMissLimit < 0
      ? DEFAULT_NEAR_MISS_LIMIT
      : Math.floor(options.nearMissLimit);

  const visited = new Set<string>(resolved);
  const seedSet = new Set<string>(resolved);
  const frontier: FrontierEntry[] = [];
  let current: string[] = [...resolved];
  let iterations = 0;
  /** 因 maxFanout 真的漏掉了尚未访问的节点——此时不动点未达成 */
  let withheldByFanout = false;
  /** maxNodes 截断时被拒的候选数 */
  let overflowTotal = 0;
  let stopReason: 'fixpoint' | 'max_nodes' | 'max_iterations' = 'fixpoint';

  for (let iteration = 1; iteration <= limits.maxIterations; iteration++) {
    const candidates = new Set<string>();

    for (const group of groupByRule(spec, current)) {
      const edges = await edgesForRule(client, group.rule, group.nodes);

      // 按「来源节点」聚合，fanout 是每个来源节点在这条规则上的边数。
      // derive.ts 对 (from, relation, to) 去过重，所以边数 = 不同对端节点数。
      const bySource = new Map<string, string[]>();
      for (const edge of edges) {
        const targets = bySource.get(edge.source);
        if (targets) targets.push(edge.target);
        else bySource.set(edge.source, [edge.target]);
      }

      for (const source of [...bySource.keys()].sort(compareStrings)) {
        const targets = bySource.get(source)!;
        // maxFanout 管的是「在调用方要求之外扩张多远」，不是「答不答种子本身」。
        // 种子豁免：常见物品（minecraft:stick 有 332 条 input_of）会超过阈值，
        // 若连种子的第一跳都跳过，闭集就不再是该物品 graph usages 的超集——
        // 那是核心正确性断言。种子只在第 1 层出现在 current 里，所以这等价于
        // 只豁免第一跳；之后的节点照常受限。
        if (targets.length > limits.maxFanout && !seedSet.has(source)) {
          const sourceType = nodeTypeOf(source);
          if (sourceType) {
            frontier.push({
              nodeId: source,
              nodeType: sourceType,
              reason: 'high_fanout',
              wouldAdd: targets.length,
              via: group.rule.relation,
            });
          }
          // visited 在本层内不变，所以这个判断与组的处理顺序无关
          if (targets.some(target => !visited.has(target))) withheldByFanout = true;
          continue;
        }
        for (const target of targets) {
          if (!visited.has(target)) candidates.add(target);
        }
      }
    }

    iterations = iteration;

    if (candidates.size === 0) {
      stopReason = 'fixpoint';
      break;
    }

    const discovered = [...candidates].sort(compareStrings);
    if (visited.size + discovered.length > limits.maxNodes) {
      const room = Math.max(0, limits.maxNodes - visited.size);
      for (const nodeId of discovered.slice(0, room)) visited.add(nodeId);
      const rejected = discovered.slice(room);
      overflowTotal = rejected.length;
      for (const nodeId of rejected) {
        const nodeType = nodeTypeOf(nodeId);
        if (nodeType) {
          frontier.push({ nodeId, nodeType, reason: 'max_nodes', wouldAdd: 0, via: null });
        }
      }
      stopReason = 'max_nodes';
      break;
    }

    for (const nodeId of discovered) visited.add(nodeId);
    current = discovered;
    if (iteration === limits.maxIterations) stopReason = 'max_iterations';
  }

  // 迭代上限用尽时，最后一层新增的节点还没被展开。只有「本策略下确实还能走」的
  // 才算未完成——若它们全是终端节点，那其实已经到了不动点。
  const expandable = (nodeId: string): boolean => {
    const nodeType = nodeTypeOf(nodeId);
    return nodeType !== null && rulesFor(spec, nodeType).length > 0;
  };
  let unexpandedTotal = 0;
  if (stopReason === 'max_iterations') {
    const unexpanded = current.filter(expandable);
    unexpandedTotal = unexpanded.length;
    for (const nodeId of unexpanded) {
      frontier.push({ nodeId, nodeType: nodeTypeOf(nodeId)!, reason: 'max_iterations', wouldAdd: 0, via: null });
    }
  }

  const reachedFixpoint = stopReason === 'fixpoint' || (stopReason === 'max_iterations' && unexpandedTotal === 0);
  const saturated = reachedFixpoint && !withheldByFanout;

  const nodes = [...visited].sort(compareStrings);
  const counts: Record<GraphNodeType, number> = { item: 0, tag: 0, recipe: 0, loot_source: 0 };
  for (const nodeId of nodes) {
    const nodeType = nodeTypeOf(nodeId);
    if (nodeType) counts[nodeType] += 1;
  }

  frontier.sort(
    (a, b) =>
      compareStrings(a.reason, b.reason) ||
      compareStrings(a.nodeId, b.nodeId) ||
      compareStrings(a.via ?? '', b.via ?? ''),
  );
  const frontierTotal = frontier.length;
  const frontierIds = new Set(frontier.map(entry => entry.nodeId));
  const frontierReturned = frontier.slice(0, MAX_FRONTIER);

  const { nearMisses, total: nearMissTotal } = await computeNearMisses(
    client,
    visited,
    nodes,
    frontierIds,
    nearMissLimit,
    policyName,
  );

  const result: ClosureResult = {
    policy: policyName,
    seeds: {
      requested,
      resolved,
      unknown,
      didYouMean: unknownSuggestions?.byQuery,
    },
    counts,
    nodes,
    frontier: frontierReturned,
    nearMisses,
    iterations,
    saturated,
    limits,
  };

  if (options.includeNodeDetails) {
    const rows = await loadNodes(client, nodes);
    result.nodeDetails = nodes.map(nodeId => rows.get(nodeId)).filter((row): row is GraphNodeRow => !!row);
  }

  if (stopReason === 'max_nodes') {
    result.truncated = { returned: nodes.length, total: nodes.length + overflowTotal, by: 'max_nodes' };
  } else if (unexpandedTotal > 0) {
    const expandableTotal = nodes.filter(expandable).length;
    result.truncated = {
      returned: expandableTotal - unexpandedTotal,
      total: expandableTotal,
      by: 'max_iterations',
    };
  } else if (frontierTotal > frontierReturned.length) {
    result.truncated = { returned: frontierReturned.length, total: frontierTotal, by: 'frontier_limit' };
  } else if (nearMissTotal > nearMisses.length) {
    result.truncated = { returned: nearMisses.length, total: nearMissTotal, by: 'near_miss_limit' };
  }

  return result;
}

// ── near_misses ─────────────────────────────────────────────────

/**
 * 闭包收敛后一次性算：与闭集相邻、但自己不在闭集里的节点，按「被多少个闭集成员
 * 碰到」排序取 top-N。已经在 frontier 里的排除掉，避免同一件事报两遍。
 * `why` 用确定性模板生成，不调模型。
 */
async function computeNearMisses(
  client: Client,
  closure: ReadonlySet<string>,
  closureNodes: readonly string[],
  frontierIds: ReadonlySet<string>,
  limit: number,
  policyName: ClosurePolicyName,
): Promise<{ nearMisses: NearMiss[]; total: number }> {
  if (limit <= 0) return { nearMisses: [], total: 0 };

  const candidates = new Map<string, { touched: Set<string>; relations: Set<GraphRelation> }>();
  const record = (inside: string, outside: string, relation: GraphRelation): void => {
    if (closure.has(outside) || frontierIds.has(outside)) return;
    let entry = candidates.get(outside);
    if (!entry) {
      entry = { touched: new Set(), relations: new Set() };
      candidates.set(outside, entry);
    }
    entry.touched.add(inside);
    entry.relations.add(relation);
  };

  for (let i = 0; i < closureNodes.length; i += SQL_CHUNK) {
    const chunk = closureNodes.slice(i, i + SQL_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const [outgoing, incoming] = await Promise.all([
      client.execute({
        sql: `SELECT from_node_id, relation, to_node_id FROM graph_edges WHERE from_node_id IN (${placeholders})`,
        args: [...chunk],
      }),
      client.execute({
        sql: `SELECT from_node_id, relation, to_node_id FROM graph_edges WHERE to_node_id IN (${placeholders})`,
        args: [...chunk],
      }),
    ]);
    type Row = { from_node_id: string; relation: GraphRelation; to_node_id: string };
    for (const row of outgoing.rows as unknown as Row[]) {
      record(row.from_node_id, row.to_node_id, row.relation);
    }
    for (const row of incoming.rows as unknown as Row[]) {
      record(row.to_node_id, row.from_node_id, row.relation);
    }
  }

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1].touched.size - a[1].touched.size || compareStrings(a[0], b[0]))
    .slice(0, limit);

  const rows = await loadNodes(
    client,
    ranked.map(([nodeId]) => nodeId),
  );

  const nearMisses: NearMiss[] = [];
  for (const [nodeId, entry] of ranked) {
    const nodeType = rows.get(nodeId)?.node_type ?? nodeTypeOf(nodeId);
    if (!nodeType) continue;
    const relations = [...entry.relations].sort(compareStrings);
    nearMisses.push({
      nodeId,
      nodeType,
      display: rows.get(nodeId)?.display ?? null,
      touchedBy: entry.touched.size,
      relations,
      why: `共 ${entry.touched.size} 个闭集成员经 ${relations.join(' / ')} 与之相邻，但未被 ${policyName} 策略纳入`,
    });
  }

  return { nearMisses, total: candidates.size };
}
