# 配方结构化槽位大面积缺失：根因与修复

**状态：根因已定位，采集侧已改，实机重新导出验证通过。**（2026-08-21）

原文是一份跨设备交接文档，用于在有整合包实例的机器上继续排查。排查已完成，本文改为记录
结论。**原先的主假设（`getIngredients()` 抛异常）已被证伪**，不要再往那个方向查。

---

## 1. 现象

作者实机验证后报告：agent 通过本项目查询，判定整合包里**存在大量坏配方**，但这些配方在
游戏内实际可用。

## 2. 根因：`isSpecial()` 的语义被用错了

`source/RecipeSource.java` 原先这样判定：

```java
boolean unparsed = rawJson == null || safeIsSpecial(recipe, recipeId) || !inputsStructured;
List<RecipeOutputRow> outputs = unparsed ? List.of() : outputRows(registries, recipeId, recipe);
```

`Recipe#isSpecial()` 的语义**不是**「没有固定配方」，而是「**别进原版配方书**」。模组给自己
的非工作台配方类型几乎都覆写成 `true`——Create 的 `ProcessingRecipe`、FarmersDelight 的
`CuttingBoardRecipe` 等——好让自己的配方不污染配方书。据此丢弃产物，等于把整类模组配方在
图里变成只有入边的孤点。

### 2.1 证据链

在 Seki 实例（MC 1.21.1 / NeoForge 21.1.247，234 mods / 11909 配方）上：

| 观察 | 数值 | 说明 |
|---|---|---|
| `unparsed` 总数 | 3959（33.2%） | 系统性 |
| `unparsedNoRawJson` | **0** | `encodeRecipe` 一次没挂，排除第一个条件 |
| 导出那次日志里的 exporter 异常 | **0 条** | `special flag` / `read ingredients` / `materialize` / `encode` 全为 0；只有 40 条 `Failed to parse ingredient`（全是 youkaisfeasts）。**没有任何东西抛过异常** |
| 该类型 100% 中招的类型数 | **62 个，3659 条** | 全有或全无 = 类级常量的签名，不是逐条数据的问题 |
| 混合类型 | 8 个，300 条中招 | 这些才是逐条数据决定的 |

`refurbished_furniture:workbench_constructing` 444/444、`farmersdelight:cutting` 390/390、
`create:cutting` 369/369——按类型整齐地全军覆没。

**排除法定死**：3959 条里有 **3039 条** `raw_json` 非 NULL 且输入行完整（item/tag 齐全，
零 `custom` 占位）。三个条件里前两个都排除了，`safeIsSpecial` 又没抛异常，所以只能是
`recipe.isSpecial()` 正常返回了 `true`。

### 2.2 三类成因的准确拆分

| 成因 | 数量 | 判定 |
|---|---|---|
| `isSpecial()` 误用 | 3039 | **缺陷**，输入齐全，只有产物被丢 |
| JSON 兜底不认的原料形状（如 `materials`） | 529 | 缺陷，可扩兜底 |
| 自定义 ingredient / ingredient 解析失败 | 391 | 部分合理，写 `custom` 占位 |

### 2.3 原文错在哪（已修正）

- ~~「一旦判定 `unparsed`，`recipe_inputs` / `recipe_outputs` 一行都不写」~~ —— **输入照写**。
  只有产物被第 153 行无条件丢弃。所以 `isolatedRecipeNodes` 只有 732 而不是 3959：多数配方
  有入边、缺出边。
- ~~主假设：`getIngredients()` 在 1.21.x 被改过，大量配方抛异常落到兜底~~ —— 日志里零异常。

原文**对**的部分：本仓 `RecipeSource.java` 与 Delightify-IDE 版逐字节相同（已复核：exporter
共 17 个 Java 文件，11 个逐字节相同，6 个差异全是改名——`OUTPUT_DIR`、命令名、提示语前缀、
注释；`SCHEMA_VERSION` 两边都是 3）。

## 3. 影响面：盲区已经污染过结论

消费端也没有兜底——旧项目 `importer.ts` 只把 `raw_json` 原样存下，`graph/build.ts` 建边纯靠
`recipe_outputs`，新旧两仓这行代码一模一样。所以旧 exporter 的数据带着完全相同的盲区，
**此前基于旧数据做的整合包改动是在这个盲区下完成的**。

规模：**1419 个物品**在 `recipe_outputs` 里查不到任何产出方，但 `raw_json` 里有。抽样含
`minecraft:stripped_oak_log`、`farmersdelight:tree_bark`、`minecraft:seagrass` 这类常见物。

已证伪的具体结论（见 `.delightify-level/审计报告-2026-08-21.md` §2.3）：

```
farm_and_charm:stove/improved_bread   unparsed=1   recipe_outputs=[]
  ingredients: [{"tag":"seki:doughs/leavened_savory"} ×2]
  result:      {"count":2, "id":"minecraft:bread"}
```

面包不止燕麦一条路，而且第二条的原料是 `seki:`——**作者自己的命名空间**。作者特意搭的路，
工具告诉他不存在。

**盲区是单向的**，据此可以划可信边界：输入照写，所以「谁消耗了 X」「按 id 删配方」仍然可信；
「X 由什么产出」「删了还有没有替代路径」「这个物品是不是拿不到」全部需要重验。

## 4. 已经改了什么（`RecipeSource.java`）

1. **`isSpecial()` 移出判定**：`unparsed = rawJson == null || !inputsStructured`。真正的原版
   特殊配方无需靠它识别——它们的 JSON 里没有任何原料键，兜底返回 `false`，照样落到
   `!inputsStructured`。`safeIsSpecial` 已删除。
2. **产物与 `unparsed` 解耦**：`outputRows` 对每条配方都调用。
3. **新增产物 JSON 兜底** `jsonFallbackOutputs`：`getResultItem()` 为空时从 `raw_json` 的
   `result` / `results` / `output` 捞，认得裸字符串、`{"id":…}`、`{"item":…}`、
   `{"item":{"id":…}}`（FD cutting 的嵌套形状）与数组多产物；跳过流体产物；**只写注册表里
   真实存在的物品**（包内有引用未安装模组的坏配方，写进去就是凭空多出的图节点）。
4. **新增 `safeOutputRows`**：`getResultItem` 现在对每条配方都会调用，模组实现里有假定
   客户端/世界上下文的，必须兜住异常——否则被外层捕获后整条配方会退化成连 `raw_json` 都
   没有的 unparsed 行。
5. `EXPORTER_VERSION` / `mod_version` 升到 **0.2.0**，用于区分新旧快照。

表结构未动，`schema_version` 仍为 3；`docs/contract.md` 的 `unparsed` 语义已同步。

预期：3741 条 unparsed 配方能捞回产物。

## 5. 验证结果（exporter 0.2.0，2026-08-21 23:30 重新导出）

旧快照的项目库备份在实例 `.delightify-level/project-2026-08-21-0320.db`，可随时复现对照。

| 指标 | 旧（0.1.0） | 新（0.2.0） | 变化 |
|---|---:|---:|---|
| `unparsed` | 3959（33.24%） | 920（7.73%） | **−3039** |
| `recipe_outputs` 行 | 7900 | 11728 | +3828 |
| 有产出方的物品 | 5524 | 6886 | **+1362** |
| `graph.isolatedRecipeNodes` | 732 | 44 | **−94%** |
| `recipe_inputs` 行 | 35633 | 35633 | 无变化 |
| items / tags / recipes 总数 | — | — | 无变化 |

**−3039 与 §2.1 推断的「3039 条纯粹由 `isSpecial()` 误判」完全吻合**，根因判断得到独立确认。

回退检查（必须为零，否则修复引入了新的数据损坏）：

- 旧库有产物的配方，新库丢失 **0 条**
- 同配方同槽位产物 id 被改写 **0 条**——改动是纯增量
- `recipe_outputs` 指向 `items` 表中不存在的物品 **0 条**——注册表校验生效
- exporter 日志 `ingredientsFailed` / `encodeFailed` / `materializeFailed` **全为 0**，`safeOutputRows` 一次都没兜到异常

`parsedButNoOutput` 从 50 涨到 144 **不是回退**：其中 97 条在旧库本就是 `unparsed=1`（不进这个统计桶），属重新归类；旧库就 parsed 且无产物的那批反而从 50 降到 47。

具体链路复核：`minecraft:bread` 现有两个产出方——`farm_and_charm:stove/improved_bread`（2 个）与
`vintagedelight:oat_bread`，均 `unparsed=0`。§3 里那条被盲区藏掉的路已恢复可见。

## 6. 剩余 920 条的构成

| 缺什么 | 数量 | 说明 |
|---|---:|---|
| 只缺输入 | 488 | JSON 兜底不认的原料形状，主要是 `materials`（含全部 444 条 `refurbished_furniture:workbench_constructing`，其产物已全部捞回） |
| 输入产物都有 | 390 | 仅因某个原料槽读不出而标记，实际可用；嵌套备选原料（`children`、`ingredient: [...]`）是主因 |
| 两者都缺 | 41 | |
| 只缺产物 | 1 | |

其中 **191 条 `minecraft:crafting` 是模组的 `CustomRecipe`**（`alexscaves:cave_map`、
`alexsmobs:bison_upgrade` 等），本就没有固定配方，**标记 unparsed 是正确的，不要去"修"**。

全库仍然完全孤立（无入边无出边）的配方只剩 44 条，其中 34 条正是上述 `CustomRecipe`。

## 7. 仍待做

采集侧（按收益排序）：

1. **`materials` 形状的原料兜底** —— 488 条只缺输入的绝大部分，一个形状换 444 条。
2. **嵌套/备选原料**（`children`、`ingredient: [...]` 数组）—— 影响 390 条的标记准确性，
   以及 `minecraft:stonecutting` 33 条、`farmersdelight:cooking` 38 条等。
3. `youkaisfeasts:cuisine` 的 `base` 字段可考虑单列为 `role = catalyst` 的输入。

检索/呈现侧（不依赖上面任何一条）：

4. **把 unparsed 配方作为边界报出来**，而不是静默消失。`graph usages` / `closure` 已有
   `frontier` / `nearMisses` 机制，这正是它该覆盖的东西。
5. **`docs/using.md` 里写清 `unparsed` 的含义**（改完 `dl skill --install` 重新生成），
   并告诉 agent 可以读 `raw_json` 兜底。
6. **`import run` 结束时报告 unparsed 比例**，异常高就在 stderr 提示。
7. **`diagnose` 支持轮转日志**：现在只扫 `logs/latest.log`，导出后若再启动过游戏，日志已轮转成
   `logs/<日期>-N.log.gz`，`log.exceptions: {}` 会是「扫错文件」而非「没有异常」。本次排查
   差点被这一点误导。

其他：

8. **重跑审计**：按 §3 的可信边界重验反向推理结论。实例里已有一份
   `.delightify-level/exporter-0.2.0-对照报告.md` 做了第一轮，其数据经复核准确。
9. exporter 的 17 个 Java 文件声明 `package …dl_exporter.*` 却仍在 `mpide_exporter/` 目录下——
   改包名时目录没跟着改。能编译但属于该清理的债。

## 8. 跨设备恢复清单

```bash
git pull && pnpm install && pnpm build     # build 必须：CLI 直接 import packages/core/dist/
bin/dl skill --install                     # 不能省，见下
bin/dl import detect && bin/dl graph stats && bin/dl diagnose
```

> ⚠️ 已安装的 SKILL.md 里钉的是**生成它那台机器的绝对路径**。换机器、换仓库位置都要重新
> 生成，否则 skill 里每条命令都会失败。这个绑定要到发 npm 之后才能解掉。

Windows 上编译 exporter 还需要 **JDK 21**（只有 JRE 不行，Gradle 要 `javac`）。
`services.gradle.org` 在国内常超时，可从 `mirrors.cloud.tencent.com/gradle/` 取发行版放进
`~/.gradle/wrapper/dists/gradle-<版本>-bin/<hash>/`。
