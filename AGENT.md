# AGENT.md

给**开发本仓库**的 agent。先读本文，再动手。

> 如果你的任务是在作者的整合包实例上查询和改包，读 [`docs/using.md`](docs/using.md)，不是本文。

## 1. 这是什么

Delightify-level 把一个 Minecraft 整合包在**游戏里加载完成后的最终状态**做成本地库，并在其上提供确定性检索与变更预览，供外部 agent 使用。

要理解在做什么、为什么这么做，读 [`docs/design.md`](docs/design.md)。一句话版本：**核心问题是召回不是精确率**——模型不乱编，但它和作者都不知道包里到底有什么，于是漏。所有设计都围绕"找全，且找不全时能自知"。

## 2. 环境

```bash
pnpm install
pnpm build          # 只构建 shared + core，产物在 dist/
pnpm typecheck      # 唯一的自动化校验手段
```

- Node ≥ 18，pnpm ≥ 9。exporter 需 **Java 21**，走 `pnpm exporter:build` / `exporter:runClient`。
- `scripts/agent-query.mjs` **直接 import `packages/core/dist/`**。改了 core 不 `pnpm build`，CLI 跑的是旧代码。这是最常见的自坑方式。
- **没有测试框架**。改动靠 `pnpm typecheck` 加手动跑 CLI 验证。新增确定性算法（尤其闭包扩张）时，优先写成纯函数并留可断言的输入输出，为将来接测试留口子。

## 3. 代码地图

| 路径 | 职责 |
|---|---|
| `packages/exporter/` | 游戏内 mod（Java）。`ExportCommand` → `ExporterService` → `source/*` 各注册表导出器 → `db/Schema` 写 SQLite |
| `packages/core/src/database/` | `schema.ts` drizzle 表定义；`schema-manager.ts` 建表/建索引/迁移的声明式注册表 |
| `packages/core/src/mod-data-importer/` | 读快照 → 写 `project.db`，含 `loot-sources` 派生与 `validator` |
| `packages/core/src/graph/` | `build.ts` 物化图谱，`query.ts` stats/usages/neighbors/path，`closure.ts` 闭包扩张与边界报告，`derive.ts` 派生 |
| `packages/core/src/lookup/` | `did_you_mean`（编辑距离）与 `projectPath` 发现。确定性，不进模型 |
| `packages/core/src/browse/` | 浏览层查询：物品/配方过滤、分面、画布读取、图标字节。人用过滤，不进 `agent-query` |
| `packages/core/src/scope/` | 呈现层后端：闭包结果固化为可 add/drop/review 的 scope |
| `packages/present/static/` | 人审页 + 图鉴页；由 `scripts/present-serve.mjs` 提供（`/` 与 `/b`） |
| `packages/core/src/embedding/` | `text.ts` 组装待嵌入文本（纯函数），`build.ts` 增量构建，`search.ts` 检索 |
| `packages/core/src/engine/` | `ir.ts` 变更 IR，`actions/*` 与 `composites/*` 各动作的 dry-run，`blast-radius.ts` 影响面，`dispatch.ts` 分发 |
| `packages/core/src/unify/` | 跨 mod 同概念候选与合并预览 |
| `packages/core/src/export/` | `kubejs-emitter.ts` 生成受管脚本；写盘、撤销 |
| `packages/core/src/llm/` | provider 抽象（openai / ollama / anthropic），目前只被 embedding 用 |
| `packages/shared/src/types/` | 跨包类型 |
| `bin/dl` | 统一入口。`dl <域>` → agent-query，`dl serve` → present-serve，`dl skill` → skill-gen，`dl diagnose` → diagnose-recipes |
| `scripts/lib/stdout-guard.mjs` | 把 core 的 console 改道 stderr。**每个 CLI 脚本必须最先 import 它**（不变量 4.3） |
| `scripts/agent-query.mjs` | 外部 agent 的 JSON 入口，`import` / `graph` / `embed` / `scope` |
| `scripts/skill-gen.mjs` + `packages/skill/config.mjs` | 从 `docs/using.md` 生成 SKILL.md / AGENTS.md。**改指令要改源文档再重生成，不要改产物** |

`packages/core/src/index.ts` 把所有子模块 `export *`。新增子模块记得挂上去。

## 4. 不可违反的不变量

违反这些等于毁掉项目的价值主张，改动前请确认没有踩到：

**4.1 确定性层不引入模型。** 闭包扩张、影响面、dry-run、图查询必须是纯 SQL / 图算法。可复现是这层的全部价值；一旦让模型决定走哪条边，就在刚消灭幻觉的地方重开了口子。

**4.2 事实与推断物理隔离。** 导入自快照的事实表不写任何推断结果。派生数据进独立表并带 `source` / `model_id` / `generated_at`，使其可重算、可审计、可整体丢弃。

**4.3 stdout 只有 JSON。** `agent-query` 的 stdout 必须是单个 `{ ok, data? , error? }`，日志和用法提示一律走 stderr，失败退出码非 0。调用方在解析这个。

**4.4 集合返回必须有上限并自报截断。** 新增任何可能返回集合的命令，都要有默认上限并在超限时返回 `truncated: { returned, total, by }`。上下文预算是硬约束，写在代码里而不是文档里。

**4.5 写盘只碰受管文件。** 仅 `kubejs/server_scripts/zzz_delightify_level_generated.js`、`kubejs/client_scripts/zzz_delightify_level_generated.js`、`kubejs/.delightify-level-generated.json`，且必须带 `@delightify-level-generated` 标记。**没有该标记的文件一律不覆盖。** 不碰 `mods/`、作者手写脚本、config。

**4.6 快照 schema 三处同步。** 改导出表结构必须同时改 `packages/exporter` 的 `db/Schema.java`、`packages/core` 的 importer 与 `database/schema*.ts`、以及 [`docs/contract.md`](docs/contract.md)，并升高 `schema_version`（当前 **3**）。少改一处就是静默的数据损坏。

**4.7 不复活 IDE 遗留。** 本仓不加 Electron 壳、聊天框、工作台 UI、应用内 agent 编排、Intent Spec、Gate、Knowledge Center。见 [`docs/design.md`](docs/design.md) §11。允许本地 web 的**浏览层**（图鉴 / 选取 / 导出 ID）和**呈现层**（人审 scope），见设计 §3 / §3.1；二者分开，都不得长回工作台或编辑器。从 Delightify-IDE 只许复用只读浏览所需的图标与查询，不搬动作入口和工作台壳。

## 5. 常见改动怎么做

**加一个 CLI 命令**：在 `packages/core/src/<域>/` 实现并从该域的 `index.ts` 导出 → `pnpm build` → 在 `agent-query.mjs` 的域分发里加分支 → 更新 [`docs/cli.md`](docs/cli.md) 与 [`docs/using.md`](docs/using.md)。注意 4.3 与 4.4。

**加一张表**：在 `database/schema.ts` 加 drizzle 定义，并在 `database/schema-manager.ts` 的注册表里加同名条目（列 + 索引）——**两处都要**，`schema-manager` 才是实际建表的地方。派生表注意 4.2。

**加一种图关系**：`graph/build.ts` 物化新边 → `graph/query.ts` 的 relation 白名单 → 更新 `docs/world.md` 的边列表与 `docs/using.md` 的说明。已有关系：`member_of` / `input_of` / `output_of` / `obtained_from`。

**加一个引擎动作**：`engine/actions/` 或 `engine/composites/` 下新增 → 在 `engine/dispatch.ts` 注册 → 确认 `blast-radius` 能覆盖它的影响面。动作只产出 dry-run 结果，落盘走 `export/`。

**改 exporter**：Java 侧改完要 `pnpm exporter:build`，并按 4.6 同步三处。验证要真进游戏跑 `/dl_export dump`。

## 6. 已知债务

改到附近时顺手修，别绕开：

| 位置 | 问题 |
|---|---|
| `graph/query.ts` `itemUsages` | ~~无结果上限~~ 已加 `limit`（默认 200）与 `truncated` |
| `mod-data-importer/importer.ts`、`database/schema-manager.ts` | 七十多处 `console.log` 直写 stdout，会冲掉 4.3 要求的那个 JSON。**目前靠 `agent-query.mjs` 把 console 整体改道 stderr 兜住**，是壳在替 core 擦屁股。根治要把 core 的日志换成注入的 logger 或直接删掉 |
| `embedding/search.ts` | 检索时 `SELECT item_id, vector, source_text FROM item_embeddings` **全量载入内存**再算相似度。数万物品规模下需要改增量或近似检索 |
| `database/schema-manager.ts` | 仍带 IDE 时代的遗留表：`plans` / `plan_snapshots` / `agent_runs` / `intent_specs` / `gate_reviews` / `guided_sessions` / `detect_reports`。按 4.7 它们不属于本项目，应清理 |
| `agent-query.mjs` | 硬编码 `../packages/core/dist/*` 相对路径，要求使用者 clone 并构建本仓。应改为发布 `dl` bin |
| `agent-query.mjs` | ~~`projectPath` 强制位置参数~~ 已支持省略：`--project` / `DL_PROJECT` / cwd 上溯 |
| 全局 | 无测试框架。CI（`.github/workflows/ci.yml`）只跑 typecheck + build + 脚本可解析 + skill 可用性，**没有端到端冒烟**：快照 → 导入 → 查询这条链全靠手动验 |

## 7. 现在该做什么

路线图见 [`docs/design.md`](docs/design.md) §10。**`graph closure` 已完成**（闭包扩张 + `frontier` + `near_misses`，见 `graph/closure.ts` 与 [`docs/plans/graph-closure.md`](docs/plans/graph-closure.md)），关系性遗漏这条已经消掉。

**呈现层已有第一刀**（`scope` CLI + `present-serve` 审核页，见 [`docs/plans/presentation-layer.md`](docs/plans/presentation-layer.md)）。自然语言建 scope 仍未做。

**浏览层已有第一刀**（`/b` 图鉴 + 选取导出 + 降级画布，见 [`docs/plans/browse-layer.md`](docs/plans/browse-layer.md)）。JEI `recipe_views` 采集、把选取喂给 `scope create` 以外的动作都还没做。

**响应契约补全已有第一刀**（`did_you_mean`、项目发现、`graph usages` 上限）。

**摄入已接进 CLI**（`import detect` / `import run`），至此 exporter 快照 → `project.db` → 检索 / 图鉴是一条完整的链，不再需要使用者自己写脚本调 `importModData`。

下一步是路线图第 4 项 `dl index` / `dl map`，或问作者要不要先做自然语言建 scope / JEI 采集。

**上一个阻塞项已解除**：配方结构化槽位大面积缺失（实机 33% 配方 `unparsed`，agent 因此误判为
「坏配方」）。根因是 `isSpecial()` 的语义被用错——它是「别进原版配方书」而非「没有固定配方」，
模组几乎都覆写成 `true`，据此丢弃产物让整类配方成了只有入边的孤点。exporter 0.2.0 已修并实机
验证：`unparsed` 3959 → 920，有产出方的物品 5524 → 6886，孤立配方节点 732 → 44，零回退。
详见 [`docs/plans/recipe-unparsed-triage.md`](docs/plans/recipe-unparsed-triage.md)。

**遗留**：基于旧快照做出的**反向推理结论（「X 由什么产出」「删了还有没有替代路径」）需要重验**，
正向的（「谁消耗了 X」）不受影响——旧盲区只丢产物不丢输入。剩余 920 条 unparsed 的构成与
后续采集侧改进（`materials` 形状、嵌套备选原料）见该文档 §6 / §7。

不确定优先级时问作者，不要自行扩大范围。

## 8. 不要做

- 不要在事实表里塞推断，不要在确定性路径里塞模型调用。
- 不要新增未在 `docs/design.md` 里的对外概念。要加先改设计文档。
- 不要为了让 CLI 跑通而绕过 `pnpm build` 去改 `dist/`。
- 不要在文档里承诺尚未实现的命令。用 `[计划]` 标注，或干脆不写。
