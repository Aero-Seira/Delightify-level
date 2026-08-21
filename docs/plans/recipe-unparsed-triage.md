# 交接：配方结构化槽位大面积缺失

**这是一份跨设备交接文档。** 排查在有整合包实例的机器上继续，本文替代口头交接。

读完本文你应当能直接动手，不需要重新推导已经确定的结论。

---

## 1. 现象

作者在实机验证后报告：agent 通过本项目查询，判定整合包里**存在大量坏配方**，但这些配方在游戏内实际可用。

## 2. 已经确定的（不要重新查）

### 2.1 `unparsed` 不是「配方坏了」

`packages/exporter/.../source/RecipeSource.java:152-153`：

```java
boolean unparsed = rawJson == null || safeIsSpecial(recipe, recipeId) || !inputsStructured;
List<RecipeOutputRow> outputs = unparsed ? List.of() : outputRows(registries, recipeId, recipe);
```

`unparsed = 1` 的语义是「**导出器没能把它结构化**」。三个触发条件：

| 条件 | 含义 | 证据 |
|---|---|---|
| `rawJson == null` | `encodeRecipe` 编码失败（codec 问题） | 该行 `raw_json` 为 NULL |
| `safeIsSpecial(...)` | 原版特殊配方（染甲、复制成书等），本来就没有固定配方 | `type_id` 形如 `minecraft:crafting_special_*` |
| `!inputsStructured` | `recipe.getIngredients()` 抛异常或返回读不出的东西，且 JSON 兜底也失败 | `raw_json` 非 NULL 但无输入行 |

**关键后果**：一旦判定 `unparsed`，`recipe_inputs` / `recipe_outputs` **一行都不写**。

### 2.2 下游因此无法区分「采集缺口」与「坏数据」

- 图里是没有任何边的孤立节点 → `graph usages` 查不到、`closure` 走不到
- 图鉴里 `primaryOutput: null`，画布空白
- `docs/using.md`（即 SKILL.md 常驻部分）**从未解释过 `unparsed`**，只有 `contract.md` 提了一句

所以 agent 判定「坏配方」是完全合理的推理。**这是我们这侧的缺陷**，且违反 design.md 的核心原则「找全，且找不全时能自知」——`unparsed` 恰是一个已知的采集缺口，我们却静默丢弃而非作为边界报告。

### 2.3 排除项

- **exporter 的配方逻辑没有变过。** 本仓 `RecipeSource.java` 与 Delightify-IDE 版**逐字节相同**，只差包名（`mpide_exporter` → `dl_exporter`）。所以现象差异来自**环境**（MC / loader / 模组版本），不是代码回归。不要再去 diff 两个仓库的 exporter。

### 2.4 顺带发现的隐患（与本问题无关，但该修）

exporter 的 17 个 Java 文件全部声明 `package io.github.aeroseira.dl_exporter.*`，却仍在 `mpide_exporter/` 目录下——改包名时目录没跟着改。能编译说明 Gradle 忍了，但属于该清理的债。

---

## 3. 下一步：跑诊断

```bash
cd <整合包实例根>
<仓库>/bin/dl diagnose            # 或 dl diagnose --project <实例根>
```

一条命令采齐全部证据，stdout 一个 JSON。它同时查**快照**（`dl-exporter/export.sqlite`）与**项目库**（`.delightify-level/project.db`）并对比，还会扫 `logs/latest.log`。

### 判读表

| 字段 | 含义 |
|---|---|
| `comparison.verdict` | **先看这个。** 两边一致 = 采集侧（改 Java）；不一致 = importer 丢了（改 TypeScript） |
| `project.recipes.unparsedRatio` | 比例。个位数百分比可能正常（特殊配方本来就有），几十个百分点就是系统性问题 |
| `unparsedNoRawJson` vs `unparsedWithRawJson` | **分流的关键。** 前者多 = `encodeRecipe` 挂了；后者多 = `getIngredients()` 挂了。两条修法完全不同 |
| `vanillaTypeUnparsed` | 原版类型也中招的数量。若连 `minecraft:crafting_shaped` 都中招，几乎可以断定是 API 层面的问题而非模组序列化器 |
| `topUnparsedTypes` | 分布。集中在少数 mod = 序列化器问题；均匀铺开 = API 问题 |
| `parsedButNoOutput` | `unparsed=0` 却没有产物——**这是另一类 bug**，不要和 unparsed 混为一谈 |
| `log.exceptions` | exporter 自己打的 WARN 里的异常类名统计。**答案往往已经写在这里** |
| `graph.isolatedRecipeNodes` | 下游影响面：这就是 agent 眼中「坏配方」的数量 |

### 主假设

`getIngredients()` 在 MC 1.21.x 系列被改过多次。若整合包 MC 版本比 IDE 时代新，很可能大量配方从该 API 拿不到东西，落到 `addJsonFallbackInputs` 的 JSON 兜底，而模组自定义序列化器的 JSON 形状不是原版的 `ingredients` / `key`，兜底也失败。

`log.exceptions` 与 `unparsedWithRawJson` 两项就能证实或证伪。**先跑诊断再讨论修法。**

---

## 4. 无论采集侧结论如何，都该做的三件事

这三条不依赖排查结论，可以并行推进：

1. **把 unparsed 配方作为边界报出来**，而不是静默消失。`graph usages` / `closure` 已有 `frontier` / `nearMisses` 机制，这正是它该覆盖的东西。
2. **SKILL.md 里写清 `unparsed` 的含义**（改 `docs/using.md` 后 `dl skill --install` 重新生成），并告诉 agent 可以读 `raw_json` 兜底。
3. **`import run` 结束时报告 unparsed 比例**，异常高就在 stderr 提示。这是导入时就该发现的问题，不该等 agent 查询时才暴露。

---

## 5. 跨设备恢复清单

在跑整合包的那台机器上：

```bash
git clone git@github.com:Aero-Seira/Delightify-level.git   # 或 git pull
cd Delightify-level
pnpm install
pnpm build            # 必须。CLI 直接 import packages/core/dist/
```

**然后必须重新生成 skill：**

```bash
bin/dl skill --install
```

> ⚠️ **这一步不能省。** 已安装的 SKILL.md 里钉的是**生成它那台机器的绝对路径**
> （`/Users/aeroseira/Repositories/Delightify-level/bin/dl`）。在另一台机器上——
> 尤其是 Windows——那个路径不存在，skill 里每一条命令都会失败。仓库换位置也要重新生成。
> 这个绑定要到发 npm 之后才能解掉。

验证环境就绪：

```bash
bin/dl import detect          # 确认快照在哪、可不可用
bin/dl graph stats            # 确认项目库有数据
bin/dl diagnose               # 本次排查的入口
```

---

## 6. 项目当前状态（截至 2026-08-21）

全部已提交并推送到 `origin/main`。CI（`.github/workflows/ci.yml`）跑 typecheck + build + 脚本可解析 + skill 可用性，绿。

| 层 | 状态 |
|---|---|
| exporter | Java 侧完整，`recipe_views`（JEI 画布）仍是 TODO |
| import | `dl import detect` / `run` **[已有]**，导入会一并物化图谱 |
| 检索层 | 闭包扩张 + `frontier` + `nearMisses` **[已有]** |
| 响应契约 | `did_you_mean`、`projectPath` 自动发现、`usages` 上限 **[已有]** |
| 呈现层 | `dl serve` 的 `/` 审 scope **[已有]** |
| 浏览层 | `dl serve` 的 `/b` 图鉴 **[已有]**，画布走结构化网格 / 槽位列表降级 |
| skill | `dl skill --install` **[已有]**，从 `docs/using.md` 生成 |

**已知债务**（详见 [`../../AGENT.md`](../../AGENT.md) §6）：无测试框架、CI 没有端到端冒烟、core 里七十多处 `console.log` 靠 `scripts/lib/stdout-guard.mjs` 兜住、`bin/dl` 未发 npm。

**未在真实数据上验证过的**：导入路径此前只用 6 物品的自造夹具跑过；大整合包规模下的分页与分面性能没压过。本次实机验证正是第一次真实数据接触，也正因此暴露了本文的问题。
