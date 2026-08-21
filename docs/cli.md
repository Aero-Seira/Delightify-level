# CLI 参考

工作方式见 [`using.md`](./using.md)。本文只列参数。

```bash
bin/dl [<projectPath>] <import|graph|embed|scope> <命令> [参数]   # 等价于下面这行
node scripts/agent-query.mjs [<projectPath>] <import|graph|embed|scope> <命令> [参数]
```

`bin/dl` 是统一入口：`dl serve` 转 `present-serve.mjs`，`dl skill` 转 `skill-gen.mjs`。

`<projectPath>` 可省略：`--project <path>`、环境变量 `DL_PROJECT`、或从 cwd 上溯 `.delightify-level/project.db`（`import` 还认快照 `dl-exporter/export.sqlite`，那时库还没建出来）。stdout 仅 JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。id 不存在时另有 `did_you_mean`（候选 id 列表，带 `score` / `reason`）。

## import

把 exporter 的快照摄入 `project.db`。**其余所有域的前置**。

```
detect [--file <快照路径>]
run    [--file <快照路径>]
```

`detect` 只看不写：报快照在哪、`sourceKind`、`schema_version`、`capabilities` 与四类计数，`imported` 说明项目库是否已存在。`run` 执行导入，**并一并物化图谱**，不必再跑 `graph rebuild`；重复跑是幂等的（先清事实表再写）。

不给 `--file` 就按下列相对路径依次找：`dl-exporter/export.sqlite`、`.dl-exporter/export.sqlite`、`delightify-level-exporter/export.sqlite`、`.delightify-level-exporter/export.sqlite`，以及四条 legacy 路径。

大包导入是分钟级，进度写 stderr（`[45%] 导入配方...`）。core 内部的日志同样只走 stderr——stdout 永远只有那一个 JSON。

## graph

```
stats
usages <itemId> [--limit n]
closure <seed> [<seed>...] [--policy recipe-impact|obtainability|same-concept] [--max-iterations n] [--max-nodes n] [--max-fanout n] [--near-misses n] [--detail ids|full]
neighbors <nodeId> [--depth 1-3] [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both]
path <from> <to> [--max-depth n]
rebuild
```

`neighbors` / `path` / `closure` 可省略 `item:` 前缀。`usages` 每一路（tag / 输入配方 / 输出配方 / 来源）默认最多 200 条，超限填 `truncated`；`--limit` 改这个上限。`usages` / `neighbors` / `path` 在 id 不存在时 `ok: false` 并带 `did_you_mean`。

### closure

在给定关系策略下把种子扩张到**不动点**，返回闭集 + 边界报告。

| 策略 | 回答 | maxIterations | maxNodes | maxFanout |
|---|---|---|---|---|
| `recipe-impact`（默认） | 改这些会波及谁 | 4 | 5000 | 200 |
| `obtainability` | 这些怎么获得 | 6 | 5000 | 100 |
| `same-concept` | 哪些是同一个东西 | 2 | 1000 | 64 |

`--max-*` 覆盖上限，生效值在返回的 `limits` 里回显。`--near-misses n` 控制 `nearMisses` 条数（默认 20，`0` 关闭）。`--detail full` 附上闭集节点的 `graph_nodes` 行。

返回字段：

| 字段 | 含义 |
|---|---|
| `seeds` | `requested` / `resolved` / `unknown`。有不存在的种子照常跑，并填 `didYouMean`；全不存在才 `ok: false` 且顶层带 `did_you_mean` |
| `counts` / `nodes` | 闭集分类型计数与全部 node_id（字典序） |
| `saturated` | **是否真到了不动点**。被 `maxNodes` / `maxIterations` / `maxFanout` 截断一律 `false` |
| `frontier` | 停在哪：`high_fanout`（该节点在某条关系上边太多，`wouldAdd` 是边数）/ `max_nodes` / `max_iterations`，最多 200 条 |
| `nearMisses` | 与闭集相邻但没被纳入的节点，按被多少个闭集成员碰到排序 |
| `limits` / `iterations` | 生效上限与实际扩张层数 |
| `truncated` | 被哪个上限截断了什么，`by` 为 `max_nodes` / `max_iterations` / `frontier_limit` / `near_miss_limit` |

`saturated: false` 意味着**结果可能不全**，看 `frontier` 决定是放宽哪个上限还是就此交给作者。

## scope

把一次 `graph closure` 固化成可审核对象。种子必须是 id，不做自然语言召回。

```
create <name> <seed> [<seed>...] [--policy recipe-impact|obtainability|same-concept] [--max-iterations n] [--max-nodes n] [--max-fanout n] [--near-misses n]
list
show <name> [--members-limit n]
add <name> <nodeId>
drop <name> <nodeId>
recompute <name> [--max-iterations n] [--max-nodes n] [--max-fanout n] [--near-misses n]
review <name>
```

`name` 须匹配 `^[a-z][a-z0-9_-]{0,63}$`。`add` 的节点不存在时 `ok: false` 并带 `did_you_mean`。

成员公式：`(上次闭包节点 ∪ extras) − exclusions`。`add` / `drop` 只改 extras / exclusions；`recompute` 仍用原种子跑闭包。`show` 的 `members` 默认最多 200，超限填 `truncated`。`counts` 始终是全量。

人审页面（长驻进程，不是 `agent-query`）：

```
node scripts/present-serve.mjs [<projectPath>] [--port 7450] [--scope <name>]
```

stdout 一行 `{ ok, data: { url, port, scope, browse } }`，之后只写 stderr。只绑 `127.0.0.1`。`/` 是审 scope；`/b` 是图鉴（人用过滤，不是 agent 检索管线，不挂到 `agent-query`）。

## embed

须作者允许后再 `build`（会把物品名发给 provider）。

```
build
search <文本> [--top n]
similar <itemId> [--top n]
```

`similar` 在物品不存在时 `ok: false` 并带 `did_you_mean`。`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_EMBEDDING_MODEL`，或 `OLLAMA_ENDPOINT` / `OLLAMA_EMBEDDING_MODEL`。`LLM_ACTIVE_PROFILE=openai-api|ollama-local`。

## skill

把 `docs/using.md` 生成成可直接装进 agent 的 skill。**内容的单一来源是 `docs/using.md`，不要手改产物。**

```
dl skill [--target claude|agents] [--out <dir>] [--command <前缀>] [--install] [--check]
```

| 选项 | 含义 |
|---|---|
| `--target claude` | 默认。目录式 `SKILL.md` + `reference/`（cli / world / contract 三份，按需加载） |
| `--target agents` | 单文件 `AGENTS.md`，给读单文件的 harness |
| `--install` | 装到该 harness 的默认位置。claude 是 `~/.claude/skills/delightify-level/` |
| `--command` | 调用前缀。默认钉死本仓 `bin/dl` 的绝对路径；发到 npm 后传 `--command dl` |
| `--check` | 断言产物可用性：frontmatter、死链、残留的 `node scripts/` 与 `pnpm build`、引用的 reference 是否真打包、`SKILL.md` 是否超 24 KB 上下文预算。产物目录存在时**另外**比对是否与源文档一致（用来查已安装的那份过期没）。**有问题退出码非 0**，已挂 CI |

生成时会把仓库相对链接改写成 skill 内的相对路径，并去掉「先 `pnpm build`」这类只对本仓开发者成立的话。

## diagnose

配方结构化槽位缺失时的采证入口。背景与判读见 [`plans/recipe-unparsed-triage.md`](./plans/recipe-unparsed-triage.md)。

```
dl diagnose [--project <path>] [--file <快照>] [--log <latest.log>] [--samples 5]
```

同时查快照与项目库并对比：两边一致说明导入没丢东西、问题在采集侧；不一致说明是 importer 的锅。另外扫 `logs/latest.log` 统计 exporter 自己打的 WARN 异常类名。stdout 一个 JSON，可直接贴给协助排查的人。
