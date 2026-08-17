# 从 Delightify-IDE 搬了什么

旧仓：`/Users/aeroseira/Repositories/Delightify-IDE`  
本仓产品名 **Delightify-level**。2026-08-17 从 Delightify-IDE 拆出世界层。

## 复制并保留

| 来源 | 落点 | 用途 |
|---|---|---|
| `packages/exporter/src` + Gradle | `packages/exporter` | 游戏内最终态导出（未复制 `build/`） |
| `services/database` | `packages/core/src/database` | project.db；已去掉 agent/intent/gate/guided/detect 表定义 |
| `services/mod-data-importer` | `packages/core/src/mod-data-importer` | 快照导入 + 战利品派生 + 建图 |
| `services/graph` | `packages/core/src/graph` | 事实图谱 |
| `services/embedding` | `packages/core/src/embedding` | 物品向量 |
| `services/engine` | `packages/core/src/engine` | dry-run / blast |
| `services/export/kubejs-emitter.ts` | `packages/core/src/export` | 受管 KubeJS |
| `services/unify` | `packages/core/src/unify` | 同名查询 |
| `services/llm` | `packages/core/src/llm` | 仅服务 embedding |
| shared 中的物品/配方/引擎/写出/设置 URL 辅助 | `packages/shared` | 类型 |
| `scripts/agent-query.mjs` | `scripts/agent-query.mjs` | 外部 agent CLI |

## 故意不搬

- Electron、renderer、工作台壳、IPC
- 应用内 Agent 编排、Intent Spec、Gate、引导式规划、Detect UI
- Knowledge Center 与模组百科图
- datapack / Almost Unified emitter（旧仓仍在，需要时再搬）
- 规格快照 `设计/01–10`、M2/M3 路线、易用性反思

## 尚未接到 CLI 的能力

`importModData`、`engineDryRun`、`previewKubeJs` / `exportKubeJs` 已在 `@delightify/core`，还没有 `agent-query` 子命令。下一步就是把它们挂上，并写 Skill。
