# Exporter

NeoForge **1.21.1** / Java **21** 游戏内 mod。从运行时注册表、RecipeManager、已解析 tag 导出最终态 SQLite。

契约：[`docs/contract.md`](../../docs/contract.md)。改表须升 `Schema.SCHEMA_VERSION` 并同步 importer。

## 用法

```bash
pnpm exporter:build
pnpm exporter:runClient
```

进单人世界后：

```
/dl_export dump
```

输出：`<实例>/dl-exporter/export.sqlite`。

专用服也能跑该命令，但不含依赖客户端渲染的贴图与配方视图。

## 行为

- 主线程只做最小快照，序列化与写库在后台线程。
- 写临时文件后原子改名。
- 贴图优先导出路径；无法离线重建的模型才在游戏内渲染。
- sqlite-jdbc 经 jarJar 打进 mod jar。

版本钉在 `gradle.properties`（NeoForge / ModDevGradle / sqlite-jdbc）。默认编译 NeoForge `21.1.233`。
