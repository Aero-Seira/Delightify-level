# CLI 参考

工作方式见 [`using.md`](./using.md)。本文只列 `agent-query` 的参数。

```bash
node scripts/agent-query.mjs <projectPath> <graph|embed> <命令> [参数]
```

stdout 仅 JSON：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

## graph

```
stats
usages <itemId>
closure <seed> [<seed>...] [--policy recipe-impact|obtainability|same-concept] [--max-iterations n] [--max-nodes n] [--max-fanout n] [--near-misses n] [--detail ids|full]
neighbors <nodeId> [--depth 1-3] [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both]
path <from> <to> [--max-depth n]
rebuild
```

`neighbors` / `path` / `closure` 可省略 `item:` 前缀。

### closure

在给定关系策略下把种子扩张到**不动点**，返回闭集 + 边界报告。

| 策略 | 回答 | maxIterations | maxNodes | maxFanout |
|---|---|---|---|---|
| `recipe-impact`（默认） | 改这些会波及谁 | 4 | 5000 | 200 |
| `obtainability` | 这些怎么获得 | 6 | 5000 | 100 |
| `same-concept` | 哪些是同一个东西 | 2 | 1000 | 64 |

`--max-*` 覆盖上限，生效值在返回的 `limits` 里回显。`--near-misses n` 控制 `nearMisses` 条数（默认 20，`0` 关闭）。`--detail full` 附上闭集节点的 `graph_nodes` 行。

返回字段：

| 字段 | 含义 |
|---|---|
| `seeds` | `requested` / `resolved` / `unknown`。有不存在的种子照常跑，全不存在才 `ok: false` |
| `counts` / `nodes` | 闭集分类型计数与全部 node_id（字典序） |
| `saturated` | **是否真到了不动点**。被 `maxNodes` / `maxIterations` / `maxFanout` 截断一律 `false` |
| `frontier` | 停在哪：`high_fanout`（该节点在某条关系上边太多，`wouldAdd` 是边数）/ `max_nodes` / `max_iterations`，最多 200 条 |
| `nearMisses` | 与闭集相邻但没被纳入的节点，按被多少个闭集成员碰到排序 |
| `limits` / `iterations` | 生效上限与实际扩张层数 |
| `truncated` | 被哪个上限截断了什么，`by` 为 `max_nodes` / `max_iterations` / `frontier_limit` / `near_miss_limit` |

`saturated: false` 意味着**结果可能不全**，看 `frontier` 决定是放宽哪个上限还是就此交给作者。

## embed

须作者允许后再 `build`（会把物品名发给 provider）。

```
build
search <文本> [--top n]
similar <itemId> [--top n]
```

`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_EMBEDDING_MODEL`，或 `OLLAMA_ENDPOINT` / `OLLAMA_EMBEDDING_MODEL`。`LLM_ACTIVE_PROFILE=openai-api|ollama-local`。
