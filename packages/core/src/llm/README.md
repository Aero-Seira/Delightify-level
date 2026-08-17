# services/llm — LLM 服务层（knowledge agent 使用中）

> **状态（2026-07-17 更新）**：本目录**不再孤立**。知识维护 Agent v1（`services/knowledge/agent.ts`）经 `createLLMService()` 使用本模块。早前"孤立废弃"的标注（2026-06-13/06-30）已过时。

## 现状

- `providers/{openai,anthropic,ollama,base}.ts` — 三家 LLM provider 封装（鉴权、请求、流式、缓存），当前知识 Agent 的调用基础设施。
- `service.ts` / `types.ts` — 统一服务入口与配置。其中旧 JAR 字节码分析路线（`registrationPattern` 等）的任务逻辑已废弃，但服务工厂本身正在被知识 Agent 复用。

## 将来语义 Agent 重启时的参考

provider 调用层是可复用的基础设施。规格 Agent（语义识别 + 执行规划 + 置信×风险输出）启动时，**复用 `providers/` 与服务工厂，按规格重写任务逻辑**，不要从零造 provider 轮子。自动改包语义层仍处搁置状态，见 `docs/current/` 与 CLAUDE.md 的 Agent 边界说明。

## 需对齐的规格（重启前须重新审视，可能与届时实现有差异）

- 设计/03：Intent-Spec 决策模型
- 设计/05：引导式规划模式
- 设计/09：Agent 层
- 安全纪律：绝不静默猜测，一切可审、可逆、出 diff。
