# CLAUDE.md

Delightify-level 把 Minecraft 整合包的**运行时最终态**做成可查询世界，供外部 agent 使用。

- 读 [`docs/world.md`](docs/world.md) 和 [`docs/agent.md`](docs/agent.md)。
- 查询走 `scripts/agent-query.mjs`，stdout 为 JSON。
- 先查世界再提议改动；查询结果里没有的 id 当作幻觉丢掉。
- 写盘只碰 Delightify-level 受管文件（`@delightify-level-generated`），先 preview 再 export。
- 本仓不做桌面 IDE，不做应用内 Agent 编排。可做：CLI、导入、MCP/Skill、图谱/向量/引擎。
