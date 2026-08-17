# 外部 agent 怎么用这个世界

前置：`pnpm build`；目标实例已导入过快照（存在 `<projectPath>/.delightify/project.db`）。

```bash
node scripts/agent-query.mjs <projectPath> <graph|embed> <子命令> [参数]
```

stdout 恒为 JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

## graph（导入后即可用）

```bash
node scripts/agent-query.mjs <projectPath> graph stats
node scripts/agent-query.mjs <projectPath> graph usages biomesoplenty:fir_planks
node scripts/agent-query.mjs <projectPath> graph neighbors biomesoplenty:fir_planks --depth 2
node scripts/agent-query.mjs <projectPath> graph path biomesoplenty:fir_log biomesoplenty:fir_boat
node scripts/agent-query.mjs <projectPath> graph rebuild
```

节点：`item:` / `tag:` / `recipe:` / `loot:`。边：`member_of`、`input_of`、`output_of`、`obtained_from`。`neighbors` / `path` 可省略 `item:` 前缀。

## embed（需 provider，显式构建）

物品名称会发给 embedding provider。不要在未授权时跑 `embed build`。

```bash
node scripts/agent-query.mjs <projectPath> embed build
node scripts/agent-query.mjs <projectPath> embed search "铜锭" --top 10
node scripts/agent-query.mjs <projectPath> embed similar biomesoplenty:fir_planks --top 10
```

环境变量与旧仓相同：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_EMBEDDING_MODEL`，或 `OLLAMA_ENDPOINT` / `OLLAMA_EMBEDDING_MODEL`。

## 纪律

1. 先查世界，再提议改动。查询结果里没有的 id 当作幻觉丢掉。
2. 替换或统一前先 `graph usages`（或日后的 blast）。
3. 写盘只碰 Delightify 受管文件；先 preview 再 export（写出 CLI 尚未接到本入口）。
4. 不要把整份 `project.db` 塞进上下文。用 usages / neighbors / search 取片段。
