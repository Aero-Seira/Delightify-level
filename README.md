# Delightify-level

本项目是面向 Minecraft 整合包开发过程中，面向开发者 agent 的**可视化运行时世界知识库**：包含物品、配方、tag、战利品、世界生成等游戏内实时性世界知识的最终态，并配合建立图谱、向量检索等手段，确保让 agent 具备整合包项目的游戏内知识，并提供统一的动作工具，以标准 skill 形式整合给 agent 使用，从而起到提升 agent 意图理解，提高开发效率的作用。同时可视化的世界知识库能够对人类开发者起到整合零散知识，降低认知负担的辅助作用。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `packages/exporter` | 游戏内导出 mod |
| `packages/core` | 导入、图谱、向量、引擎、动作 |
| `packages/shared` | 跨包类型 |
| `scripts/agent-query.mjs` | 外部 agent 查询入口（JSON） |

项目库：`<实例>/.delightify-level/project.db`。

## 用法

```bash
pnpm install
pnpm build

# 导出器（需 Java 21）
pnpm exporter:build
pnpm exporter:runClient
# 进档后：/dl_export dump
# 快照：<实例>/dl-exporter/export.sqlite

# 查询（须已导入快照）
node scripts/agent-query.mjs <实例路径> graph stats
node scripts/agent-query.mjs <实例路径> graph usages minecraft:copper_ingot
node scripts/agent-query.mjs <实例路径> embed search "铜锭" --top 10
```

摄入快照目前走 `@delightify/core` 的 `importModData`，尚未接到 `agent-query`。

## 文档

- [`AGENT.md`](AGENT.md) — 给外部 agent 的入口（先读这个）
- [`docs/world.md`](docs/world.md) — 世界、工具、边界
- [`docs/agent.md`](docs/agent.md) — CLI 参数表
- [`docs/contract.md`](docs/contract.md) — 导出快照 schema
