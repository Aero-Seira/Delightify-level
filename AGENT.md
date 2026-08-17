# AGENT.md

给在本仓或作者整合包实例上工作的外部 agent。先读本文，再动手。

Delightify-level 提供整合包的**运行时最终态**（游戏加载完之后的物品、配方、tag、战利品），以及图谱和向量检索。规划、改手写脚本、和作者确认，在你自己的 harness 里做。不要在本仓实现聊天框或桌面 IDE。

细节：[`docs/world.md`](docs/world.md)（数据从哪来）、[`docs/contract.md`](docs/contract.md)（快照表）、[`docs/agent.md`](docs/agent.md)（CLI 参数表）。

## 1. 先确认世界在不在

`projectPath` 必须是 Minecraft **实例根**（里面有 `mods/`），不是本 git 仓库根。

| 路径 | 含义 |
|---|---|
| `<projectPath>/mpide-exporter/export.sqlite` | 游戏内 `/mpide_export dump` 的快照。没有它就无法导入 |
| `<projectPath>/.delightify-level/project.db` | 已导入的世界库。没有它，查询会失败 |

没有快照：告诉作者把 exporter 放进 `mods/`，进档执行 `/mpide_export dump`。  
有快照、无 `project.db`：导入尚未接到 CLI，用 `@delightify/core` 的 `importModData({ projectPath })`（先 `pnpm build`）。不要手写插入事实表。

查询前在本仓根执行过 `pnpm build`。

## 2. 查询协议

```bash
node scripts/agent-query.mjs <projectPath> <graph|embed> <命令> [参数]
```

- stdout **只有** JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。
- 先看 `ok`，再读 `data`。失败时退出码非 0。
- 不要把 `project.db` 整库或 `SELECT * FROM items` 的结果塞进上下文。

### graph（本地，导入后即可用）

```bash
node scripts/agent-query.mjs <p> graph stats
node scripts/agent-query.mjs <p> graph usages <itemId>
node scripts/agent-query.mjs <p> graph neighbors <nodeId> [--depth 1-3] [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both]
node scripts/agent-query.mjs <p> graph path <from> <to> [--max-depth n]
node scripts/agent-query.mjs <p> graph rebuild
```

节点：`item:<id>`、`tag:<id>`、`recipe:<id>`、`loot:<category>:<sourceId>`。`neighbors` / `path` 可省略 `item:`。

边：`member_of`（物品→tag）、`input_of`（物品/tag→配方）、`output_of`（物品→配方）、`obtained_from`（物品→战利品来源）。

`usages` 一次给出所属 tag、作为输入/输出的配方、获取来源。改某个物品前先跑它。

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
| 「换成面粉会动谁」 | `graph usages <itemId>`；跨步关系用 `neighbors --depth 2` |
| 「这两种东西能不能转化」 | `graph path a b` |
| 「和这块木板同类的」 | `embed similar <itemId>`，或 `neighbors` + `member_of` 反查 tag |
| 「这个 tag 里有谁」 | `graph neighbors tag:<tagId> --relation member_of --direction in` |
| 改完要写脚本 | 见 §4。先查证，id 必须来自查询结果 |

查询结果里没有的注册名 = 幻觉，丢掉。不要用训练数据里的通用 id 代替本包事实。

## 4. CLI 还没有、库里已有的

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

## 5. 直接读库

`project.db` 是 SQLite。复杂 ad-hoc 可以用 sqlite3，但：

- 加 `LIMIT`，按需列，不要倒全表。
- 事实以导入后的表为准，不要去翻 `mods/*.jar` 当真相。
- 图谱与向量表结构见 [`docs/world.md`](docs/world.md) 和 [`docs/contract.md`](docs/contract.md)。

## 6. 不要做

- 不要编造本包不存在的物品/配方/tag。
- 不要把「并成哪个」「降多少成本」当成可以替作者拍板的事；可以列出选项和 usages。
- 不要在本仓加 Electron 页面、Intent Spec、Gate、应用内 Agent 循环。
- 不要在未授权时跑 `embed build`（会外发文本）。
- 不要修改 exporter 快照文件本身。
