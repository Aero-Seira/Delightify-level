# Delightify-level

整合包的**运行时世界**：物品、配方、tag、战利品的最终态，加上图谱、向量检索，以及可预览、可撤销的确定性改包工具。给外部 agent 的 harness 用，不是 IDE，也不是聊天框。

规划与改手写脚本发生在 Claude Code / Cursor / Codex 里。本仓负责把游戏里真正加载出来的包变成可查询的事实。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `packages/exporter` | NeoForge 1.21.1 游戏内导出 mod |
| `packages/core` | 导入、图谱、向量、引擎、KubeJS 受管写出 |
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
# 进档后：/mpide_export dump
# 快照：<实例>/mpide-exporter/export.sqlite

# 查询（须已导入快照）
node scripts/agent-query.mjs <实例路径> graph stats
node scripts/agent-query.mjs <实例路径> graph usages minecraft:copper_ingot
node scripts/agent-query.mjs <实例路径> embed search "铜锭" --top 10
```

摄入快照目前走 `@delightify/core` 的 `importModData`，尚未接到 `agent-query`。

## 文档

- [`docs/world.md`](docs/world.md) — 世界、工具、边界
- [`docs/agent.md`](docs/agent.md) — CLI 与查询纪律
- [`docs/contract.md`](docs/contract.md) — 导出快照 schema
