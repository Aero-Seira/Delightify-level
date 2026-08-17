# 实施计划：graph closure

路线图第 1 项（见 [`../design.md`](../design.md) §4、§10）。目标是消灭**关系性遗漏**：把「agent 多次点查询手工拼装集合」换成「一次调用返回饱和闭集 + 边界报告」。

本文是实现契约。动手前通读，尤其 §3（图谱的既有陷阱）。

## 1. 目标与非目标

**目标**

- 新增 `closureFrom()`：给定种子节点 + 关系策略，在图上扩张到**不动点**，返回闭集、`frontier`、`near_misses`。
- 挂到 CLI：`graph closure`。
- 全程确定性：纯 SQL + 图算法，无模型调用，同输入同输出，结果有序。

**非目标**（本次不做，别顺手扩范围）

- **语义种子召回**（design.md §4.1）。种子由调用方显式给出，不接 embedding。
- `scope` 持久化、`dl index` / `dl map`、`did_you_mean`、MCP、`dl` bin。
- 不新增任何表。closure 是纯查询，不落盘。
- 不改 `itemUsages` / `graphNeighbors` / `graphPath` 的现有行为（`itemUsages` 缺上限是已知债务，另行处理）。

## 2. 既有图谱事实

来自 `packages/core/src/graph/derive.ts`，实现必须建立在这些之上：

节点 `item:<id>` / `tag:<id>` / `recipe:<id>` / `loot:<category>:<sourceId>`。

边**全部单向存储**：

| 边 | 方向 | 备注 |
|---|---|---|
| `member_of` | item → tag | |
| `input_of` | item → recipe | tag 展开产生的带 `evidence = "tag:<id>"` |
| `input_of` | tag → recipe | 与上一行**并存** |
| `output_of` | item → recipe | 注意方向：**产出物指向配方**，不是反过来 |
| `obtained_from` | item → loot_source | `evidence` 是 loot_table_id |

`graph_edges` 在 `from_node_id` / `to_node_id` / `relation` 上都有索引。

## 3. 两个必须绕开的陷阱

**3.1 tag 输入是双重表示。** `deriveGraph` 对 tag 类输入既存 `tag → recipe`，又把 tag 的每个成员展开成 `item → recipe`。后果：

- 走 `item --member_of--> tag --input_of--> recipe` 得到的配方，很大程度上和直接走 `item --input_of--> recipe` 重合。集合去重后无害，但别以为少走一条就漏了。
- **真正危险的是反向**：若从配方反向走 `input_of`（`recipe <--input_of-- ?`），会一次性捞回**该配方所有 tag 输入的全部成员物品**。一个用了 `forge:ingots` 的配方能瞬间拉进几百个无关物品，再迭代一轮就全图了。

所以：**策略必须精确到 (节点类型, 关系, 方向) 三元组**，不能笼统地说"走 input_of"。

**3.2 `output_of` 的方向反直觉。** 边是 `item --output_of--> recipe`。想拿"这个配方产出什么"，要**反向**查 `to_node_id = recipe:<id> AND relation = 'output_of'`。写反了会静默给出空集。

## 4. 策略定义

策略是**纯数据**：每个 (节点类型 → 可走的 (关系, 方向) 列表)。`out` = 沿 `from→to`，`in` = 沿 `to→from`。

### 4.1 `recipe-impact`（默认）——「改了这些，什么会受影响」

| 当前节点 | 关系 | 方向 | 到达 |
|---|---|---|---|
| item | `member_of` | out | 它所属的 tag |
| item | `input_of` | out | 消耗它的配方 |
| item | `output_of` | out | 产出它的配方 |
| item | `obtained_from` | out | 掉落来源（**终端，不再扩张**） |
| tag | `input_of` | out | 消耗该 tag 的配方 |
| recipe | `output_of` | **in** | 该配方的产出物 |
| loot_source | — | — | 终端 |

关键取舍：**recipe 不反向走 `input_of`**。配方的其他输入是"共现"，不是"受影响"，走了必炸（见 3.1）。传播链条是 `物品 → 配方 → 产出物 → 再下游`，这才是影响面的真实语义。

tag 不反向走 `member_of`：那是 `same-concept` 的活。

### 4.2 `obtainability`——「这些东西怎么获得」

| 当前节点 | 关系 | 方向 | 到达 |
|---|---|---|---|
| item | `output_of` | out | 产出它的配方 |
| item | `obtained_from` | out | 掉落来源（终端） |
| recipe | `input_of` | **in** | 它的输入（item 与 tag 都会回来） |
| tag | `member_of` | **in** | tag 成员（**受 fanout 限制**） |
| loot_source | — | — | 终端 |

这里**必须**反向走 `input_of`，因为要的就是上游配料；爆炸风险由 fanout 阈值和迭代上限压住。

### 4.3 `same-concept`——「哪些是同一个东西」

| 当前节点 | 关系 | 方向 | 到达 |
|---|---|---|---|
| item | `member_of` | out | 它所属的 tag |
| tag | `member_of` | **in** | tag 成员（**严格 fanout 限制**） |
| recipe / loot_source | — | — | 不进入 |

`maxIterations` 默认 **2**（item→tag→item）。再迭代会经第二层物品的其他 tag 漂移出去，语义就散了。

### 4.4 各策略默认上限

| 策略 | maxIterations | maxNodes | maxFanout |
|---|---|---|---|
| `recipe-impact` | 4 | 5000 | 200 |
| `obtainability` | 6 | 5000 | 100 |
| `same-concept` | 2 | 1000 | 64 |

全部可被 CLI 参数覆盖。`maxFanout` 指**单个节点在单条 (关系,方向) 上的出边数**：超过就不扩张它，改为记进 `frontier`。这正是 design.md §4.3 里 `tag:forge:grain / would_add: 312` 那条的来源。

> **实现回填**：**种子豁免 `maxFanout`**。常见物品的出边数本就超阈值（实测 `minecraft:stick` 有 332 条 `input_of`、`minecraft:iron_ingot` 236 条），若种子的第一跳也被跳过，闭集就不再是该物品 `graph usages` 的超集——而那是 §11.2 的核心正确性断言。`maxFanout` 管的是「在调用方要求之外扩张多远」，不是「答不答种子本身」。种子只在第 1 层出现，故等价于只豁免第一跳。

## 5. 算法

**分层同步扩张（level-synchronous），批量 SQL，不做逐节点查询。**

```
visited ← 种子（已解析、去重）
frontier ← []
current ← 种子
for it in 1..maxIterations:
    next ← ∅
    按 (relation, direction) 分组，对 current 中类型匹配该规则的节点批量查边
      —— 每组一条 SQL，node id 分块 500 个（对齐 loadNodes 的做法）
    把返回的边按「来源节点 + 规则」聚合：
        若某来源节点在该规则下的边数 > maxFanout：
            frontier += {nodeId, reason:'high_fanout', wouldAdd: 边数, via: relation}
            跳过，不加入 next
        否则把对端节点中不在 visited 的加入 next
    若 |visited| + |next| > maxNodes：
        按确定性顺序截断，未纳入者记 frontier（reason:'max_nodes'）
        saturated ← false；break
    若 next 为空：saturated ← true；break
    visited ∪= next；current ← next
若循环因 maxIterations 结束且 next 非空：
    saturated ← false，剩余记 frontier（reason:'max_iterations'）
```

**不动点判据**：某轮 `next` 为空 ⇒ `saturated: true`。这是"找全了"的唯一凭据，必须如实上报——被上限截断时绝不能报 `true`。

> **实现回填**：上面两句在 `high_fanout` 上是自相矛盾的——跳过一个高扇出节点后 `next` 可能正好为空，但那显然不是不动点。按后半句（"被上限截断时绝不能报 true"）执行：
>
> - 只要某次 `high_fanout` 跳过时，被跳过的对端里**存在尚未访问的节点**，就置 `saturated: false`，哪怕该轮 `next` 为空。全部对端都已在闭集里则不算截断。
> - 反过来也做了一处收紧的**放宽**：循环因 `maxIterations` 结束时，若最后一层新增的节点在本策略下**全是终端节点**（没有任何可走规则），下一轮必然为空，此时仍报 `saturated: true`，并且不记 `max_iterations` 的 frontier 条目。
>
> 实测：`obtainability` + `--max-fanout 2` 在第 6 轮自然收敛（未触到 `maxIterations` 10），但因有 1 个节点被扇出拦下，如实报 `saturated: false`。

**批量 SQL 形状**（每条规则一次，id 分块 500）：

```sql
-- direction = out
SELECT from_node_id, relation, to_node_id, weight, evidence
  FROM graph_edges
 WHERE relation = ? AND from_node_id IN (?, ?, ...);

-- direction = in
SELECT from_node_id, relation, to_node_id, weight, evidence
  FROM graph_edges
 WHERE relation = ? AND to_node_id IN (?, ?, ...);
```

现有 `edgesFrom` / `edgesTo` 是单节点版，**不要复用**，闭包会有几千次往返。新写批量版，可放同文件。

**确定性**：所有集合转数组时按 `node_id` 字典序排序；`frontier` 按 `(reason, nodeId)` 排序；`nearMisses` 按 `(-touchedBy, nodeId)` 排序。截断也按这个顺序取前 N，保证同输入同输出。

**tag 成员 fanout 的取舍**：先取回边再判断是否超阈值（而不是先 `COUNT(*)`）。多取一次大 tag 的边，SQLite 有索引，代价可接受；换来实现简单。若日后出现性能问题，再改成先 COUNT。

## 6. near_misses

闭包收敛后一次性算，成本很低：

1. 查所有与闭集节点相邻、但对端**不在闭集内**的边（双向，同样批量分块）。
2. 按对端节点聚合：`touchedBy` = 闭集中与之相邻的**不同节点数**；`relations` = 涉及的关系去重排序。
3. 排除已在 `frontier` 里的节点（避免同一件事报两遍）。
4. 按 `touchedBy` 降序、`nodeId` 升序，取前 `nearMissLimit`（默认 20）。
5. `display` 从 `graph_nodes` 批量补齐（复用现有 `loadNodes`）。

`why` 用确定性模板生成，例如：`共 3 个闭集成员经 member_of / input_of 与之相邻，但未被 recipe-impact 策略纳入`。**不要**在这里调模型。

注意：near_misses 的候选量可能很大，聚合在内存里做，但只返回 top-N，并在 `truncated` 里报总数。

## 7. 类型契约

写在 `packages/core/src/graph/closure.ts`：

```ts
export type ClosurePolicyName = 'recipe-impact' | 'obtainability' | 'same-concept';

export interface ClosureOptions {
  policy?: ClosurePolicyName;      // 默认 recipe-impact
  maxIterations?: number;
  maxNodes?: number;
  maxFanout?: number;
  nearMissLimit?: number;          // 默认 20，0 = 关闭
  includeNodeDetails?: boolean;    // 默认 false
}

export interface FrontierEntry {
  nodeId: string;
  nodeType: GraphNodeType;
  reason: 'high_fanout' | 'max_nodes' | 'max_iterations';
  wouldAdd: number;
  via: GraphRelation | null;
}

export interface NearMiss {
  nodeId: string;
  nodeType: GraphNodeType;
  display: string | null;
  touchedBy: number;
  relations: GraphRelation[];
  why: string;
}

export interface ClosureResult {
  policy: ClosurePolicyName;
  seeds: { requested: string[]; resolved: string[]; unknown: string[] };
  counts: Record<GraphNodeType, number>;   // 闭集内各类型节点数
  nodes: string[];                          // 闭集全部 node_id，已排序
  nodeDetails?: GraphNodeRow[];             // includeNodeDetails 时
  frontier: FrontierEntry[];
  nearMisses: NearMiss[];
  iterations: number;
  saturated: boolean;
  limits: { maxIterations: number; maxNodes: number; maxFanout: number };
  truncated?: {
    returned: number;
    total: number;
    by: 'max_nodes' | 'max_iterations' | 'near_miss_limit';
  };
}
```

> **实现回填**：`truncated` 的 `by` 多一个值 **`'frontier_limit'`**。`frontier` 本身也是集合返回，AGENT.md §4.4 要求它有上限并自报截断——上面的联合类型表达不了这件事。实现里 `frontier` 封顶 **200** 条（按 §5 的 `(reason, nodeId)` 顺序取前 N，同一节点在不同规则上重复出现时再按 `via` 排序）。实测大种子集 + `--max-fanout 1` 会产生 870 条，如实报 `{returned:200, total:870, by:'frontier_limit'}`。
>
> `truncated` 只有一个，同时命中多个上限时按严重程度取一个：`max_nodes` > `max_iterations` > `frontier_limit` > `near_miss_limit`。`returned`/`total` 的所指随 `by` 变化——它描述的是**被截断的那个集合**：
>
> | `by` | `returned` / `total` |
> |---|---|
> | `max_nodes` | 闭集节点数 / 若不截断会有的节点数 |
> | `max_iterations` | 已展开 / 需展开的闭集节点数（终端节点不计） |
> | `frontier_limit` | 返回的 frontier 条数 / 总条数 |
> | `near_miss_limit` | 返回的 near_miss 条数 / 候选总数 |
>
> `high_fanout` 不进 `by`：它不截断任何**返回的**集合，由 `frontier` 条目和 `saturated: false` 承载。

`limits` 必须回显生效值——调用方要能判断结果是不是被自己的参数限死的。

**种子解析**：无前缀的按 `item:` 补全（沿用 `agent-query.mjs` 里 `normalizeNodeId` 的规则）。在 `graph_nodes` 里批量校验存在性；不存在的进 `seeds.unknown` 并**继续跑**。仅当全部种子都不存在时返回错误。不做 `did_you_mean`（那是路线图第 3 项）。

## 8. 策略表实现要求

策略定义要能被单独测，与 IO 分离：

```ts
interface TraversalRule { relation: GraphRelation; direction: 'out' | 'in'; }
type PolicySpec = {
  rules: Partial<Record<GraphNodeType, TraversalRule[]>>;
  defaults: { maxIterations: number; maxNodes: number; maxFanout: number };
};
export const CLOSURE_POLICIES: Record<ClosurePolicyName, PolicySpec>;
export function rulesFor(policy: PolicySpec, nodeType: GraphNodeType): TraversalRule[];
```

`rulesFor` 是纯函数。仓库目前没有测试框架（见 [`../../AGENT.md`](../../AGENT.md) §2），但**必须写成可断言的纯函数形态**，为将来接测试留口。不要把策略判断混进 SQL 循环里。

## 9. CLI

```bash
node scripts/agent-query.mjs <projectPath> graph closure <seed> [<seed>...] \
  [--policy recipe-impact|obtainability|same-concept] \
  [--max-iterations n] [--max-nodes n] [--max-fanout n] \
  [--near-misses n] [--detail ids|full]
```

- 多个种子走 positional，现有 `parseFlags` 已支持。
- `--detail full` 映射 `includeNodeDetails: true`。
- 无种子 → `fail('graph closure 需要至少一个 <seed>', true)`。
- 遵守 AGENT.md §4.3：stdout 只有 `{ok, data}` 单个 JSON。

## 10. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/graph/closure.ts` | **新建**：策略表、`rulesFor`、批量取边、`closureFrom`、near_misses |
| `packages/core/src/graph/index.ts` | 导出 `closureFrom` 及全部相关类型 |
| `scripts/agent-query.mjs` | `graph` 域加 `closure` 分支；顶部注释补用法 |
| `docs/cli.md` | 加 `closure` 参数 |
| `docs/using.md` | §3 意图表加「改这些会波及谁 → `graph closure`」；§4 召回缺口按实现情况回改 |
| `docs/design.md` | §4.2/§4.3/§10 的 `[计划]` 改 `[已有]` |

不要碰 `derive.ts` / `build.ts` / `schema-manager.ts`——本次不改图谱结构，不加表。

## 11. 验证

没有测试框架，用真实实例手动验证并把结果贴回报告：

1. `pnpm typecheck` 与 `pnpm build` 通过。**改完 core 必须 `pnpm build`**，否则 CLI 跑的是旧 `dist/`。
2. `graph closure <常见物品> --policy recipe-impact`：
   - `saturated` 为 `true` 或 `false` 与 `frontier` 自洽（截断了就不能报 true）；
   - 闭集 ⊇ 同物品 `graph usages` 的结果——**这是核心正确性断言，闭包不能比点查询少**；
   - 重复执行两次，输出逐字节相同（确定性）。
3. `--policy same-concept` 跑一个进了大 tag（如 `forge:ingots/*`）的物品：应看到 `high_fanout` 的 frontier 条目，而不是几百个物品涌进闭集。
4. `--policy obtainability` 跑一个深加工物品：链条应向上游走且在 `maxIterations` 内收敛。
5. `--max-nodes 50` 强制截断：`truncated` 出现，`saturated: false`。
6. 混入一个不存在的种子：进 `unknown`，其余照常；全部不存在时才 `ok: false`。
7. 记录一次大整合包上的耗时。明显超过数秒就说明退化成逐节点查询了，回头看 §5。

## 12. 交付时报告

- 每个策略各一份真实输出样例（截断到可读长度）。
- §11 第 2 条的包含关系是否成立；不成立就是 bug，不要绕过。
- 大包上的节点规模与耗时。
- 实现中发现的、与本文不符的图谱事实（比如某类边的方向或重复情况和 §2 描述不一致）——**以代码为准并回改本文**。

## 13. 实现记录（完成后回填）

**§2 的图谱事实全部与 `derive.ts` 一致**，无需更正：节点四类、边五行（含 `input_of` 的 tag/item 并存）、`output_of` 方向为 item→recipe、`graph_edges` 在 `from_node_id` / `to_node_id` / `relation` 上各有一条单列索引（`schema-manager.ts` L322-325，实例库里也确实建了）。没有 `(relation, from_node_id)` 复合索引，但实测不构成瓶颈。

三处偏离本文的实现决定，理由写在对应小节的「实现回填」里：种子豁免 `maxFanout`（§4.4）、`high_fanout` 也会让 `saturated` 为 false（§5）、`truncated.by` 增加 `frontier_limit` 且 `frontier` 封顶 200（§7）。

另有两处**代码内的取舍**，不改变契约：

- 节点类型由 **node_id 前缀**判定（纯函数 `nodeTypeOf`），不回查 `graph_nodes.node_type`。`derive.ts` 里每类节点的 id 都由固定前缀构造，二者等价，省掉逐层一次往返。
- `loadNodes` 从 `query.ts` 导出给 `closure.ts` 复用（§6.5 要求复用）。仅加 `export` 关键字，不改行为，也不从 `graph/index.ts` 对外导出，包的公开面不变。

验证环境的限制：作者实例 `Labpack-1.21.1` 的库是 `schema_version = 1` 的旧快照，`item_loot_sources` 为空，因此图里**没有 `obtained_from` 边和 `loot_source` 节点**。三个策略里与 loot 相关的规则（`recipe-impact` / `obtainability` 的 `obtained_from`）**未经真实数据验证**，其余全部走通。该实例的库路径也还是旧的 `.delightify/`，不是 CLI 期望的 `.delightify-level/`。
