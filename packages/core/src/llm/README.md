# llm

Embedding 与（可选）补全的 provider 封装：OpenAI 兼容、Anthropic、Ollama。

`embed build` / `embed search` 经 `createLLMService()` 调用这里。物品名称等文本会发给当前激活的 provider。
