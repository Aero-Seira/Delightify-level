# CLI 参考

外部 agent 的工作方式见仓库根目录 [`AGENT.md`](../AGENT.md)。本文只列 `agent-query` 的参数。

```bash
node scripts/agent-query.mjs <projectPath> <graph|embed> <命令> [参数]
```

stdout 仅 JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

## graph

```
stats
usages <itemId>
neighbors <nodeId> [--depth 1-3] [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both]
path <from> <to> [--max-depth n]
rebuild
```

`neighbors` / `path` 可省略 `item:` 前缀。

## embed

须作者允许后再 `build`（会把物品名发给 provider）。

```
build
search <文本> [--top n]
similar <itemId> [--top n]
```

`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_EMBEDDING_MODEL`，或 `OLLAMA_ENDPOINT` / `OLLAMA_EMBEDDING_MODEL`。`LLM_ACTIVE_PROFILE=openai-api|ollama-local`。
