# 在整合包上使用

给在**作者整合包实例**上工作的外部 agent。先读本文，再动手。

> 要改本仓库的代码，读 [`../AGENT.md`](../AGENT.md)，不是本文。

Delightify-level 提供整合包的**运行时最终态**（游戏加载完之后的物品、配方、tag、战利品），以及图谱和向量检索。规划、改手写脚本、和作者确认，在你自己的 harness 里做。

细节：[`world.md`](./world.md)（数据从哪来）、[`contract.md`](./contract.md)（快照表）、[`cli.md`](./cli.md)（CLI 参数表）。

## 1. 先确认世界在不在

`projectPath` 是 Minecraft **实例根**（里面有 `mods/`），不是本 git 仓库根。可以不写：在实例目录下执行，或设 `DL_PROJECT`，或传 `--project <path>`。

| 路径 | 含义 |
|---|---|
| `<projectPath>/dl-exporter/export.sqlite` | 游戏内 `/dl_export dump` 的快照。没有它就无法导入 |
| `<projectPath>/.delightify-level/project.db` | 已导入的世界库。没有它，查询会失败 |

没有快照：告诉作者把 exporter 放进 `mods/`，进档执行 `/dl_export dump`。
有快照、无 `project.db`：导入尚未接到 CLI，用 `@delightify/core` 的 `importModData({ projectPath })`（先 `pnpm build`）。不要手写插入事实表。

查询前在本仓根执行过 `pnpm build`。

## 2. 查询协议

```bash
node scripts/agent-query.mjs [<projectPath>] <graph|embed|scope> <命令> [参数]
```

- stdout **只有** JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。
- 先看 `ok`，再读 `data`。失败时退出码非 0。
- id 不存在时 `ok: false`，看 `did_you_mean`，不要自己编一个注册名再查。
- `<projectPath>` 可省略（`DL_PROJECT` 或从当前目录上溯）。
- 不要把 `project.db` 整库或 `SELECT * FROM items` 的结果塞进上下文。

### graph（本地，导入后即可用）

```bash
node scripts/agent-query.mjs <p> graph stats
node scripts/agent-query.mjs <p> graph usages <itemId> [--limit n]
node scripts/agent-query.mjs <p> graph closure <seed> [<seed>...] [--policy recipe-impact|obtainability|same-concept] [--max-nodes n] [--near-misses n]
node scripts/agent-query.mjs <p> graph neighbors <nodeId> [--depth 1-3] [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both]
node scripts/agent-query.mjs <p> graph path <from> <to> [--max-depth n]
node scripts/agent-query.mjs <p> graph rebuild
```

### scope（人审闭集）

```bash
node scripts/agent-query.mjs <p> scope create pasta minecraft:wheat --policy same-concept
node scripts/agent-query.mjs <p> scope show pasta
node scripts/present-serve.mjs <p> --scope pasta
```

人看包里有什么、勾 id 导出，开同一个进程的 `/b`（图鉴）。那是未审核的临时集合，不要当成 `scope` 或 `saturated` 闭集。

节点：`item:<id>`、`tag:<id>`、`recipe:<id>`、`loot:<category>:<sourceId>`。`neighbors` / `path` / `closure` 可省略 `item:`。

边：`member_of`（物品→tag）、`input_of`（物品/tag→配方）、`output_of`（物品→配方）、`obtained_from`（物品→战利品来源）。

`usages` 一次给出所属 tag、作为输入/输出的配方、获取来源。改某个物品前先跑它。

`closure` 是**集合**级的：给种子和策略，扩张到不再增长为止，一次给出完整闭集，不用你自己一跳一跳拼。三个策略：`recipe-impact`（改这些会波及谁，默认）、`obtainability`（这些怎么获得）、`same-concept`（哪些是同一个东西）。参数表见 [`cli.md`](./cli.md)。

**先看 `saturated`。** `true` = 在给定上限内确实到了不动点，集合是全的；`false` = 中途被上限拦下，看 `frontier` 里停在哪：`high_fanout` 说明某个节点（通常是大 tag）的边太多被跳过了，`max_nodes` / `max_iterations` 说明规模或层数用尽。要么放宽对应的 `--max-*` 重跑，要么把边界连同 `nearMisses` 一起交还作者。`nearMisses` 是「差一点被算进来」的节点，正是人最该扫一眼的地方。

### embed（会把物品名发给 provider）

只在作者允许时 `embed build`。未授权不要构建。

```bash
node scripts/agent-query.mjs <p> embed build
node scripts/agent-query.mjs <p> embed search "<自然语言>" [--top n]
node scripts/agent-query.mjs <p> embed similar <itemId> [--top n]
```

作者说「铜锭」「面食」时用 `search`，不要猜 `thermal:copper_ingot`。跨 mod 同名/近义用 `similar`。

环境变量：`OPENAI_API_KEY` + 可选 `OPENAI_BASE_URL` / `OPENAI_EMBEDDING_MODEL`；或 `OLLAMA_ENDPOINT` / `OLLAMA_EMBEDDING_MODEL`。`LLM_ACTIVE_PROFILE=openai-api|ollama-local` 强制选用。

## 3. 按任务选命令

| 作者意图 | 做法 |
|---|---|
| 「有哪些铜锭」 | `embed search "铜锭"`，再用 `graph usages` 核对每个 id |
| 「改这些会波及谁」 | `graph closure <种子...>`（默认 `recipe-impact`）。看 `saturated` 与 `frontier` |
| 「换成面粉会动谁」 | 单个物品的第一跳用 `graph usages`；要完整影响面用 `graph closure` |
| 「这东西怎么获得」 | `graph closure <itemId> --policy obtainability` |
| 「这两种东西能不能转化」 | `graph path a b` |
| 「和这块木板同类的」 | `graph closure <itemId> --policy same-concept`，或 `embed similar <itemId>` |
| 「人来审这个集合」 | `scope create <name> <种子...>`，把 `present-serve --scope <name>` 的 URL 交给作者 |
| 「打开图鉴勾一些 id」 | 让作者打开 `present-serve` 的 `/b`。导出的是未审核临时列表，不是 scope |
| 「这个 tag 里有谁」 | `graph neighbors tag:<tagId> --relation member_of --direction in` |
| 改完要写脚本 | 见 §5。先查证，id 必须来自查询结果 |

查询结果里没有的注册名 = 幻觉，丢掉。不要用训练数据里的通用 id 代替本包事实。

## 4. 当前的召回缺口（重要）

**关系性遗漏已由 `graph closure` 接管**：给定种子后，「顺着 tag 和配方还能牵扯到谁」不再需要你手工迭代，闭包会跑到不动点并在 `saturated: false` 时告诉你停在哪。改物品前跑一次 `closure`，别再用 `usages` + `neighbors` 手工拼集合。

剩下的缺口是**语义性的**——即「种子选得对不对」，闭包管不了：

- **`embed search` 的结果不是全集。** 至少再从 tag 名和 id 词干各找一轮，多找到的种子一起喂给 `closure`（它接受多个种子）。
- **跨 mod 同概念会漏。** 同一样东西可能有五个 mod 各自的 id；`--policy same-concept` 能沿共享 tag 补一部分，但没有共享 tag 的补不了。
- **`closure` 报 `saturated: false` 时结果不全。** 别当成全集用。看 `frontier` 决定放宽哪个 `--max-*`，或把边界交还作者。
- **扫一眼 `nearMisses`。** 它是「与闭集相邻但没被纳入」的节点，语义漏检最常藏在这里。
- **拿不准就把不确定性交还作者**，列出你找到的集合、`frontier` 和 `nearMisses`，别自己拍板。边界需要人看时，用 `scope create` 固化，再请作者打开 `present-serve` 的审核页；`status` 还是 `draft` 的 scope 不要当成已审集合去写盘。

## 5. CLI 还没有、库里已有的

这些在 `@delightify/core`（`packages/core/src`），**尚未**挂到 `agent-query`。需要时读源码再调，不要假装 CLI 已支持。

| 函数 | 用途 |
|---|---|
| `importModData({ projectPath })` | 检测并导入 `export.sqlite`，建图谱 |
| `queryUnifyCandidates` / `dryRunUnify` | 同名物品候选与合并预览 |
| `planEngineBlast` | 物品/tag 的配方影响面 |
| `planEngineAction` | `replace` / `retag` / `remove` / `rename` / `scale` / `hide` / `constrain_inputs` / `differentiate` / `harmonize` 的 dry-run |
| `previewKubeJs` / `exportKubeJs` / `revertKubeJs` | 预览、写出、撤销受管 KubeJS |

写盘规则：

- 只写 `kubejs/server_scripts/zzz_delightify_level_generated.js`、`kubejs/client_scripts/zzz_delightify_level_generated.js`、`kubejs/.delightify-level-generated.json`。
- 文件必须带 `@delightify-level-generated`。没有该标记的文件一律不覆盖。
- 先 `previewKubeJs`，把将写出的内容给作者看，确认后再 `exportKubeJs`。
- `revertKubeJs` 只删上述受管文件。
- 不要改 `mods/`、作者手写的 kubejs、config。

## 6. 直接读库

`project.db` 是 SQLite。复杂 ad-hoc 可以用 sqlite3，但：

- 加 `LIMIT`，按需列，不要倒全表。
- 事实以导入后的表为准，不要去翻 `mods/*.jar` 当真相。
- 图谱与向量表结构见 [`world.md`](./world.md) 和 [`contract.md`](./contract.md)。

## 7. 不要做

- 不要编造本包不存在的物品/配方/tag。
- 不要把「并成哪个」「降多少成本」当成可以替作者拍板的事；可以列出选项和 usages。
- 不要在未授权时跑 `embed build`（会外发文本）。
- 不要修改 exporter 快照文件本身。
