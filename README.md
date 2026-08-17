# Delightify-level

游戏外的**整合包世界知识平台**。把 Minecraft 实例的运行时最终态做成外部 agent 能查、能引用、能谨慎调用的知识和工具。规划与改文件交给作者正在用的 harness（Claude Code、Cursor、Codex 等）。

Delightify-level 不是 IDE，也不是又一个聊天框。

## 它提供什么

1. **世界**：游戏内 `/mpide_export dump` → 导入 `<实例>/.delightify-level/project.db`（物品、配方、tag、战利品）+ 游戏事实图谱；授权后构建物品向量。
2. **工具**：图谱/向量检索、影响面、unify 查询、引擎 dry-run、KubeJS 受管预览/写出/撤销。
3. **接口**：先用 CLI。MCP 与 Skill 按同一套函数往后加。

## 和 Delightify-IDE 的关系

旧仓 [Delightify-IDE](../Delightify-IDE) 是 Electron 改包 IDE / 自建 Agent 试验。本仓只搬走可复用的世界层与确定性引擎，文档重写。旧仓冻结，不再当主线。来源对照见 [`docs/FROM-IDE.md`](docs/FROM-IDE.md)。

## 命令

```bash
pnpm install
pnpm build

# 游戏内导出器（需 Java 21）
pnpm exporter:build
pnpm exporter:runClient   # 进档后 /mpide_export dump

# 查询已导入的世界库（IDE 不必启动）
node scripts/agent-query.mjs <实例路径> graph stats
node scripts/agent-query.mjs <实例路径> graph usages minecraft:copper_ingot
node scripts/agent-query.mjs <实例路径> embed search "铜锭" --top 10
```

摄入（把 `mpide-exporter/export.sqlite` 打进 project.db）目前仍以库函数 `importModData` 提供，CLI 封装随后补。

## 文档

- [`docs/world.md`](docs/world.md) — 产品方向
- [`docs/agent.md`](docs/agent.md) — 外部 agent 怎么用
- [`docs/contract.md`](docs/contract.md) — exporter SQLite 契约
