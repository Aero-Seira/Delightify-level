# 设计

本文说明 Delightify-level 要解决什么问题、为此选了什么架构、以及哪些是明确不做的。改动若与本文冲突，先改本文。

状态标记：**[已有]** 代码里存在；**[部分]** 库里有、CLI 未接；**[计划]** 尚未实现。

## 1. 要解决的问题

早期做法是把 exporter 的导出产物做成 skill 直接给外部 agent。实测下来：

- **精确率没问题。** 模型不会顺着幻觉乱改，它老老实实按查到的事实操作。
- **召回率是问题。** agent 按指令去检索，但它和作者**都不知道整合包里到底有什么**，于是漏掉大量相关事实。改完一个物品，忘了它在某个 tag 里，而那个 tag 是十几个配方的输入。

所以本项目的核心任务不是"能查"，是**"找全"**，以及在找不全时**让调用方知道自己没找全**。

遗漏分两类，可解性完全不同：

| 类型 | 例子 | 可解性 |
|---|---|---|
| **关系性遗漏** | 改铜锭，漏了 `forge:ingots/copper` 及其下游配方 | **可精确解**：图可达性，有确定答案 |
| **语义性遗漏** | 作者说"面食"，另外三个 mod 用了完全不同的命名 | **不可精确解**：边界由作者定 |

第一类必须完全从 agent 手里拿走——它没有停止准则，走几步就停。第二类没有全自动解，工具的职责是**把不确定性收敛到一个人能快速审完的边界上**。

## 2. 设计原则

1. **穷尽在离线，查询在片段。** 全库遍历不能进 agent 的上下文，但可以进导入阶段。昂贵的全局计算一次做完、落盘。
2. **确定性层不引入模型。** 闭包扩张、影响面、dry-run 全部是 SQL 与图算法。可复现是这层的全部价值。
3. **返回闭集与边界，不返回片段。** 一次调用给出饱和结果 + 停在哪 + 差点被算进来的是谁。
4. **上下文预算是一等约束，写在代码里而不是文档里。** 所有返回值默认截断并自报截断量。"不要把整库塞进上下文"这种话约束不了任何东西。
5. **事实与推断物理隔离。** 派生数据进独立表、带来源标记，永不混入事实表。
6. **机器负责穷尽，人负责划界。** 语义边界交还作者，但要把审核成本压到 30 秒。

## 3. 分层

| 层 | 内容 | 状态 |
|---|---|---|
| **能力层** | `@delightify/core`：导入、图谱、向量、引擎、写出 | [已有] |
| **检索层** | 种子召回 → 闭包扩张 → 边界报告；离线索引 | 闭包扩张与边界报告 [已有]，种子召回 [部分]，离线索引 [计划] |
| **知识层** | 何时查什么、不许幻觉、写盘规则 | [已有] `docs/using.md` |
| **传输层** | CLI（有 shell）/ MCP（无 shell） | CLI [已有]，MCP [计划] |
| **呈现层** | 本地 web UI，人审 scope（`frontier` / `near_misses`） | [部分]：显式种子的 scope + `present-serve`；无自然语言建 scope |
| **浏览层** | 本地 web 图鉴：物品/配方浏览、选取、导出 ID；配方类型画布 | [部分]：`present-serve` 的 `/b`；JEI `recipe_views` 采集仍缺，画布走结构化网格 / 槽位列表 |

能力层与检索层是护城河：**运行时最终态**（静态分析 JAR 拿不到）和**确定性引擎**。传输层是可替换的薄壳，不值得在选型上耗时间。

浏览层与呈现层都是给人看的本地 web，**产品独立、优先级独立**，可以同进程不同路由，但不要合成一个「IDE 里什么都有」的壳。呈现层回答「这个闭集和它的边界对不对」；浏览层回答「包里长什么样、我勾哪些 id」。后者的选取可以以后喂给 `dl scope`，**不替代**已审核的 scope。

### 3.1 浏览层

从图鉴降低作者认知负担，并给人一条不经过工作台的便利出口。沿用 Delightify-IDE 里**只读浏览**的部分（物品图标、id/名/tag/mod 过滤、多选），不沿用工作台、编辑器、聊天、Knowledge Center。

做：

- **物品渲染与查询。** 图标走已导出的 `item_resources`（客户端最终态 PNG，缺则占位）。查询是人用的过滤，不是 §4 的 agent 检索管线。
- **配方类型画布。** 布局与底板从游戏内最终态采集，写入契约已有的 `recipe_views` / `recipe_view_backgrounds`。JEI 是优先实现路径，不是唯一真相；未采集到（无 JEI / 该类型无视图）降级为结构化槽位列表。不以仓库里遗留的 `config/recipe_types` 手写模板为真相。
- **浏览与选取。** 物品、配方可浏览、可多选。
- **便利输出。** 复制或下载 ID 列表（物品 / 配方 / tag）。只出剪贴板或浏览器下载，不写实例里的 kubejs / config。这是未审核的临时集合，给作者自己用或当 `graph closure` 的种子；没有 `saturated`，也不是 scope。

不做：工作台、配方/物品编辑、写盘改包、应用内 agent、把选取直接送进 engine 动作。选中后只读展示 usages / closure 可以，跳去「改这个」不可以。

采集缺口：`RecipeViewSource` 在 exporter 里仍是 TODO，importer 已能收这两张表。补采集是浏览层的数据前置；改表须同步 exporter / importer / `docs/contract.md`，沿用现有列则不必升 `schema_version`。

## 4. 检索管线

替换掉"agent 多次点查询手工拼装"的模式。一次调用，内部三段：

### 4.1 种子召回（宽，故意过召回）

并集而非交集，宁可多不可少：

- embedding 检索 **[已有]**
- 显示名 / 翻译键的子串与 n-gram **[计划]**
- tag 名匹配（`forge:foods/pasta`）**[计划]**
- id 词干（`*_pasta` / `pasta_*`）与命名空间 **[计划]**
- `queryUnifyCandidates` 的跨 mod 等价类 **[部分]** — 已实现但未接进检索路径，是现成的召回增益

### 4.2 闭包扩张（精确，做到不动点）**[已有]**

不是 `depth=2`，是在给定关系策略下**迭代到集合不再增长**：

| 策略 | 走的边 | 回答 |
|---|---|---|
| `recipe-impact` | `member_of` → `input_of` → 反向 `output_of` → … | 改这些会波及谁 |
| `obtainability` | `output_of` / `obtained_from`，反向 `input_of` / `member_of` | 这些怎么获得 |
| `same-concept` | `member_of` 正反两向，不进配方 | 哪些是同一个东西 |

这在 SQLite 里是几十毫秒的事，agent 手工做要十几轮且必然半途而废。

策略必须精确到 **(节点类型, 关系, 方向)** 三元组：tag 类配方输入在图里是双重表示（`tag→recipe` 与展开后的 `成员item→recipe` 并存），所以从配方**反向**走 `input_of` 会一次捞回该配方所有 tag 输入的全部成员，再迭代一轮就是全图。`recipe-impact` 因此不反向走 `input_of`；`obtainability` 要的就是上游配料，反向走，靠 `maxFanout` 压住。unify 等价类尚未接进 `same-concept` **[计划]**。

### 4.3 边界报告（最重要的返回值）**[已有]**

结果集本身不解决问题，**知道结果集的边界在哪**才解决：

```json
{
  "seeds": { "requested": ["farmersdelight:pasta"], "resolved": ["item:farmersdelight:pasta"], "unknown": [] },
  "counts": { "item": 34, "tag": 6, "recipe": 91, "loot_source": 2 },
  "saturated": false,
  "frontier": [
    { "nodeId": "tag:forge:grain", "nodeType": "tag", "reason": "high_fanout",
      "wouldAdd": 312, "via": "member_of" }
  ],
  "nearMisses": [
    { "nodeId": "item:farmersdelight:raw_pasta", "touchedBy": 3,
      "relations": ["member_of"],
      "why": "共 3 个闭集成员经 member_of 与之相邻，但未被 recipe-impact 策略纳入" }
  ]
}
```

`frontier` 与 `near_misses` 把**未知的未知**变成**已知的候选**，之后就能交给人拍板。`near_misses` 的实现成本很低：闭集算完后，取集合内节点的邻居中不在集合里的，按被多少个闭集成员碰到排序取 top-N。

`saturated` 是调用方判断「找全了没有」的唯一凭据：只在真正到达不动点、且没有被 `maxNodes` / `maxIterations` / `maxFanout` 中任何一个截断时才为 `true`。种子召回的置信度分级（`confidence: high_structural | medium_semantic`）仍 **[计划]**，取决于 §4.1 落地。

## 5. 离线索引与世界地图

回答"整合包里到底有什么"。在 `importModData` 之后加 `dl index` **[计划]**，把昂贵的全局计算一次做完：

- **语义聚类**：embedding + tag 共现 + 配方共现三路信号，得到概念簇
- **tag 等价类**：成员高度重合的 tag = 同一概念的不同 mod 命名
- **配方族**：产出相同/相似物的配方分组
- **mod 关系**：公共 tag（`forge:` / `c:`）覆盖率 = 兼容度；跨 mod 配方引用数 = 集成度；连通分量 = 孤岛。**这些是算出来的事实，不是判断**
- **异常**：无配方无战利品的孤儿物品、单向 tag、重复产出

产物是 `dl map` **[计划]**——几百行、可整个进上下文的世界鸟瞰。agent 的工作流从"盲猜关键词检索"变成"**先看地图，再定点下钻**"。这是 progressive disclosure 用在数据上。

`dl audit` **[计划]** 把异常直接推给作者。这是遍历能给而 agent 给不出的东西。

## 6. scope 作为一等公民

现状每次操作都要重新回答"我关心哪些物品"，于是**每次操作独立承担一次漏检风险**。改成找全只做一次，固化成可复用、可审核的对象 **[部分]**：

```bash
# 已有：显式种子。自然语言 "面食" 仍 [计划]
node scripts/agent-query.mjs <p> scope create pasta minecraft:wheat --policy same-concept
node scripts/agent-query.mjs <p> scope show pasta
node scripts/agent-query.mjs <p> scope add pasta farmersdelight:raw_pasta
node scripts/agent-query.mjs <p> scope drop pasta create:dough
node scripts/present-serve.mjs <p> --scope pasta

dl scope "面食" --policy same-concept --save pasta   # [计划]
dl impact @pasta                                    # [计划]
```

三个收益：

1. 漏检风险从 N 次降到 1 次，且那一次有人把关。
2. 人审集合远比人审 JSON 轻松——**这是呈现层真正的用武之地**：开网页扫一眼分组和 near_misses，勾掉两个、补上一个。图鉴、过滤、导出 ID 属于浏览层（§3.1），给人看世界；不在这里冒充已审核的边界。
3. scope 可 diff。重新导入快照后能报告"新增 mod 带来 3 个新成员"。

配套硬规则：**`confidence: medium_semantic` 的 scope 不得直接进入写盘操作**，必须先经作者确认。判据来自数据，不来自模型自觉。

## 7. 对外接口

Skill 与 MCP 不是二选一，是不同层：skill 封装**知识层**，MCP 封装**传输层**。

**主路径是 skill + CLI。** 本项目最值钱的是"什么时候查什么、改前先查影响面"这套流程，MCP 的 tool schema 里没地方放这些；且 MCP 工具定义常驻上下文，是永久 token 税。加上写 KubeJS 必然要能改文件，目标受众几乎不存在没有 shell 的情况。

**MCP 排第二，且要薄。** 服务于无 shell 环境。只暴露 5 个左右任务级工具（`find_scope` / `impact` / `map` / `preview_script`），**不做 CLI 命令到 MCP 工具的一一映射**——把"召回后必须核对"这类流程烧进实现里，而不是指望模型照做。

**指令文档单一来源 + generator [已有]。** `SKILL.md`（Claude Code 目录式，带 `reference/`）与 `AGENTS.md` 由 `scripts/skill-gen.mjs` 从 `docs/using.md` 生成，`dl skill --install` 装进 harness。Cursor `.mdc` / `copilot-instructions.md` 仍 [计划]，加一个 harness 只是在 `packages/skill/config.mjs` 里多一条 `wrap`。**绝不手维护多份**——漂移的文档比没有文档更糟，所以 `dl skill --check` 在产物与源文档不一致时退出码非 0，可挂 CI。

## 8. 响应契约

所有面向 agent 的返回值统一信封 **[部分]**（`ok` / `error` / `truncated` / `did_you_mean` / 项目发现已有；`dl` bin 仍缺）：

```json
{ "ok": true,
  "data": { ... },
  "truncated": { "returned": 50, "total": 312, "by": "default_limit" } }
```

规则：

- 任何可能返回集合的命令必须有默认上限，并在超限时填 `truncated`。`graph usages` 每路默认 200；`graph neighbors` 有 `MAX_VISITED = 2000`。
- id 不存在时返回 `ok: false` 且附 `did_you_mean`（编辑距离 + 后缀/子串，不走模型）**[已有]**：`graph usages` / `neighbors` / `path`、`embed similar`、`scope add`、全部种子都不存在的 `closure` / `scope create`。部分种子不存在时 `closure` 仍跑，并在 `seeds.didYouMean` 里给出建议。
- `projectPath` 可省略：`--project` / 位置参数 > `DL_PROJECT` > 从 cwd 上溯 `.delightify-level/project.db` **[已有]**。`agent-query` 与 `present-serve` 同一套发现。

## 9. 关于小参数 LLM：暂缓

评估过在离线阶段用小模型做语义标注（`role` / `tier` / `domain`），它能创造 embedding 和图都没有的检索轴，直接打击召回问题。**当前决定不做**，理由：

- 前八节的确定性能力还没建完，那部分收益更大且无风险；
- 结构信号尚未榨干（"中间产物"用"作为输入的次数 ≫ 作为最终产物"就能推一大半），应先写规则版；
- 引入模型就需要配套评估集，否则无法判断标注可不可信。

**预留位**：将来若做，产物进独立的 `item_derived` 表，带 `model_id` + `prompt_version` + `generated_at`，永不混入事实表；返回值标注 `source`；配套规则是**派生字段可以用来找、不能用来定**。

明确不用小模型的地方（即使将来引入）：闭包扩张、给主 agent 重排结果、回答任何关于本包的问题。**mod 兼容/孤立关系也不用**——那是连通分量和 tag 覆盖率的活，算出来的比猜出来的准。

## 10. 路线图

按性价比排序：

1. ~~**`graph closure`**：不动点扩张 + `frontier` 报告~~ **[已有]**。纯 SQL 层，直接消灭关系性遗漏。
2. ~~**`near_misses`**~~ **[已有]**，随闭包一起返回。
3. ~~**响应契约补全**~~ **[已有]**：`did_you_mean`、`projectPath` 自动发现、`graph usages` 上限。剩下的是调用方体验（`dl` bin），进第 6 项。
4. **`dl index` + `dl map`**：工作量最大，解决"不知道有什么"的根问题。
5. **种子召回**（§4.1 的非 embedding 几路）+ scope 接自然语言 + 呈现层补全：scope 持久化与审核页 **[部分]**（见 §6），缺的是宽召回和 `confidence`。
6. **打包与分发**：~~`dl` bin~~ **[已有]**（`bin/dl`，尚未发 npm）、~~skill generator~~ **[已有]**；npx 免构建、去原生依赖、MCP 薄适配仍 [计划]。

**浏览层是独立轨道**（§3.1），不插入上面的性价比队列，也不替代第 5 项。**已有第一刀**：`present-serve` 的 `/b`（图鉴 / 过滤 / 选取导出 / 降级画布）。配方画布要真正到位，仍等 exporter 补上 `RecipeViewSource`。

下一步是第 4 项，它不依赖任何接口选型，可以立刻动手。

## 11. 非目标

- 不做桌面 IDE、聊天框、应用内 agent 编排、Intent Spec / Gate。规划与对话在调用方自己的 harness 里。本地 web 的浏览层（图鉴 / 选取 / 导出 ID）和呈现层（审 scope）不在此列，也不得长回工作台或编辑器。
- 不做设计与平衡判断。可以列选项和影响面，不替作者拍板"并成谁""降多少"。
- 不把 `mods/*.jar` 的静态内容当真相。事实以导入后的库为准。
- 不写作者手写的 kubejs、config、mods。写盘只碰受管文件（见 `docs/using.md`）。
