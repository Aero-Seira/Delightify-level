# 外部 agent

前置：`pnpm build`；实例已导入快照（`<projectPath>/.delightify-level/project.db` 存在）。

```bash
node scripts/agent-query.mjs <projectPath> <graph|embed> <命令> [参数]
```

stdout 只有一行 JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。失败时退出码非 0。

## graph

导入后即可用，不访问网络。

```bash
node scripts/agent-query.mjs <projectPath> graph stats
node scripts/agent-query.mjs <projectPath> graph usages biomesoplenty:fir_planks
node scripts/agent-query.mjs <projectPath> graph neighbors biomesoplenty:fir_planks --depth 2
node scripts/agent-query.mjs <projectPath> graph neighbors tag:forge:ingots/copper --relation member_of --direction in
node scripts/agent-query.mjs <projectPath> graph path biomesoplenty:fir_log biomesoplenty:fir_boat
node scripts/agent-query.mjs <projectPath> graph rebuild
```

- `neighbors` / `path` 的节点可省略 `item:` 前缀。
- `--relation`：`member_of` | `input_of` | `output_of` | `obtained_from`
- `--direction`：`out` | `in` | `both`（默认 `out`）
- `--depth`：1–3（默认 1）

`usages` 返回所属 tag、作为输入/输出的配方、获取来源。改一个物品前先跑它。

## embed

会把物品显示名等文本发给 provider。只在作者允许时执行 `embed build`。

```bash
node scripts/agent-query.mjs <projectPath> embed build
node scripts/agent-query.mjs <projectPath> embed search "铜锭" --top 10
node scripts/agent-query.mjs <projectPath> embed similar biomesoplenty:fir_planks --top 10
```

| 方式 | 环境变量 |
|---|---|
| OpenAI 及兼容 | `OPENAI_API_KEY`（必需）、`OPENAI_BASE_URL`、`OPENAI_EMBEDDING_MODEL`（默认 `text-embedding-3-small`） |
| Ollama | `OLLAMA_ENDPOINT`、`OLLAMA_EMBEDDING_MODEL`（默认 `nomic-embed-text`） |

`LLM_ACTIVE_PROFILE=openai-api` 或 `ollama-local` 可强制选用哪边。

## 纪律

1. 先查再改。结果里没有的注册名不要用。
2. 替换或合并前先 `graph usages`。
3. 不要把整个数据库或大批物品列表塞进上下文。
4. 写盘只碰带 `@delightify-level-generated` 的受管文件；先 preview。写出尚未接到本 CLI。
