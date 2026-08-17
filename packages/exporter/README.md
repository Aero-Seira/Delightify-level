# leveled Exporter

**NeoForge 1.21.1 / Java 21** 的游戏内数据导出 mod。把整合包的**运行时最终态**导出成 SQLite，供 leveled 世界库离线消费。

> 重写自旧的 1.20.1 Forge Delightify Exporter。游戏内命令暂仍是 `/mpide_export dump`，输出 `mpide-exporter/export.sqlite`；改名另做契约升级。

## 契约

导出库 schema = exporter ↔ 世界库的接口，定义在 **`docs/contract.md`**。改表即改契约，必须同步 importer 并升 `Schema.SCHEMA_VERSION`。

## 用法

```bash
pnpm exporter:runClient    # 推荐：从 monorepo 根目录启动；单机集成服务端，可导贴图/配方视图
# 进入单人世界后：
/mpide_export dump
# 输出: <serverDir>/mpide-exporter/export.sqlite
```
专用服务器（`runServer` / 生产服）亦可执行命令，但不含依赖客户端渲染的贴图与配方视图。

## 固定契约（不随实现变更）
- 命令：`/mpide_export dump`
- 输出：`<serverDir>/mpide-exporter/export.sqlite`

## 性能纪律（首要）

- 导出**异步**：仅在 server thread 做最小状态快照，序列化 + SQLite 写入在后台 worker 线程。
- 贴图**首选离线化**：导出文件引用/路径，由 IDE 离线从 JAR 提取；仅动态/BakedModel 物品在游戏内渲染兜底（复用 FBO + PBO 异步回读 + 帧预算）。
- 写临时文件 → 原子改名。

## 状态

数据地基阶段（v0.1.0），**已通过 `pnpm exporter:build`**（compileJava + jar + jarJar 嵌 sqlite-jdbc + mods.toml 模板注入均 OK）；尚未在游戏内 `runClient` 实跑。

已就绪：ModDevGradle 构建、`/mpide_export dump` 命令注册、契约 v1 全表 DDL（`db/Schema`）、异步导出架构（主线程最小快照 → worker 写库 → 原子改名）、manifest 导出（含真实 modlist_hash）、mods/items/item_creative_tabs/blocks/item_tags/translations/recipes 导出。

待实现的 source（按建议顺序）：
1. 资源/贴图（离线化策略）+ `recipe_views`（JEI，客户端）。

见 `source/package-info.java` 与主仓 `docs/current/exporter-contract-v1.md`。

## 开发

- JDK 21（NeoForge 1.21.1 要求）。
- 构建系统：ModDevGradle（`net.neoforged.moddev`）。
- 默认用 NeoForge `21.1.233` 编译；运行时最低依赖声明为 `21.1.1`。
- sqlite-jdbc 通过 **jarJar** 打进 mod jar；JDBC 驱动加载有模块化 ClassLoader 兜底（见 `db/SqliteDatabase`）。
- 版本固定在 `gradle.properties`（NeoForge / MDG / sqlite-jdbc）。

## 许可证

GPL-3.0-only。
