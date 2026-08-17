# 世界知识平台

leveled 把一个整合包实例的**运行时最终态**做成 agent 能查询的世界，以及一套确定性工具。思考、规划、改手写脚本发生在作者自己的 harness 里。

## 为什么不是 IDE

强模型在 Claude Code / Cursor / Codex 里已经会规划和改文件。再做 Intent Spec、Gate、应用内 Agent，是把模型从熟悉的工具环里拽出来。护城河是「这个包现在到底长什么样」——KubeJS、tag 合并、datapack 覆盖之后的事实，翻仓库拿不到。

## 三层

**世界**：exporter 快照 → `project.db`（物品 / 配方 / tag / 战利品 / 显示名）→ 导入时物化的游戏事实图谱 → 授权后构建的物品向量。

**工具**：检索、usages / neighbors / path、blast、unify 查询、engine dry-run、KubeJS preview。export / revert 只写 leveled 受管文件，须由 harness 确认。

**接口**：CLI 先于 MCP。Skill 教外部 agent 先查再改、id 不许编造。

## 人不待在这里

没有日常工作台。人做的是：把 exporter 放进 mods、进档导出、导入快照、需要时授权建向量。检查图谱或试搜是专业入口，不是产品首页。
