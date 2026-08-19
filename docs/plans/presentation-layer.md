# 实施计划：呈现层（scope + 本地审核页）

呈现层的产品是「人审闭集与边界」，不是图鉴。浏览层见 [`../design.md`](../design.md) §3.1，本次不做。

本文是实现契约。

## 1. 目标与非目标

**目标**

- scope 作为派生对象持久化：显式种子 + 策略 → `closureFrom()` → 可 `add` / `drop` / `recompute` / `review`。
- CLI：`agent-query` 的 `scope` 域，stdout 单个 JSON。
- 本地 web：`present-serve` 绑 `127.0.0.1`，分组呈现 + `frontier` / `near_misses` + 勾选增删。

**非目标**

- 浏览层（全包图鉴、配方画布、JEI 采集、从浏览导出 ID）。
- 语义种子召回（`dl scope "面食"`）、`dl index` / `map`、MCP、`dl` bin、`dl impact @name`。
- Electron / React / Vite / 工作台 / 编辑 / 写 kubejs。
- 改快照 schema / 升高 `schema_version`。
- 不顺手修 `itemUsages` 上限或 `did_you_mean`。

## 2. 成员公式

```
members = (last_closure.nodes ∪ extras) − exclusions
```

- `add`：撤 exclusion；若不在上次闭包里则写入 extras。
- `drop`：删 extras，写入 exclusion。
- `recompute`：仍用**原种子 + 策略**跑闭包，extras / exclusions 保留。
- extras 不升格为种子。
- 展示用 near_misses = 上次闭包的 near_misses 里还不在 members 中的。
- `frontier` 只反映上次扩张的守卫，人改成员不改它。

## 3. 表（派生，不进快照契约）

`scopes` / `scope_seeds` / `scope_extras` / `scope_exclusions`。带 `source` / `generated_at`。不复用 IDE 的 `plans`。

## 4. 命令

```
node scripts/agent-query.mjs <p> scope create <name> <seed> [<seed>...] [--policy ...]
node scripts/agent-query.mjs <p> scope list
node scripts/agent-query.mjs <p> scope show <name> [--members-limit n]
node scripts/agent-query.mjs <p> scope add <name> <nodeId>
node scripts/agent-query.mjs <p> scope drop <name> <nodeId>
node scripts/agent-query.mjs <p> scope recompute <name>
node scripts/agent-query.mjs <p> scope review <name>
node scripts/present-serve.mjs <p> [--port 7450] [--scope <name>]
```

`show` 成员默认上限 200，超限填 `truncated`。

## 5. 壳

`scripts/present-serve.mjs` + `packages/present/static/`。无构建。HTTP 只绑回环地址。stdout 一行 JSON `{ url, port }`，之后只打 stderr。
