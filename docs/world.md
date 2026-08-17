# 世界

Delightify-level 把一个整合包实例在游戏里**已经加载完成的状态**做成本地库。KubeJS、tag 合并、datapack 覆盖之后的结果在这里，不在 JAR 静态文件里。

## 数据怎么来

1. 把 exporter 放进实例的 `mods/`，进档执行 `/dl_export dump`。
2. 快照写在 `<实例>/dl-exporter/export.sqlite`。
3. `importModData` 读入 `<实例>/.delightify-level/project.db`，并物化游戏事实图谱。
4. 经作者授权后，`embed build` 为物品建立向量（名称文本会发给 embedding provider）。

## 项目库里有什么

**导出事实**：mods、items、blocks、item_tags、recipes / recipe_inputs / recipe_outputs、translations、loot_tables / loot_bindings，以及导入时派生的 `item_loot_sources`。

**图谱**（导入时构建）：

- 节点：`item:` / `tag:` / `recipe:` / `loot:`
- 边：`member_of`、`input_of`、`output_of`、`obtained_from`

**向量**（显式构建）：`item_embeddings`，用于自然语言检索和相似物品。

## 工具

只读：物品/配方检索、图谱 usages / neighbors / path、unify 同名查询、blast 影响面、engine dry-run、KubeJS preview。

写盘：`exportKubeJs` / `revertKubeJs` 只写受管文件：

- `kubejs/server_scripts/zzz_delightify_level_generated.js`
- `kubejs/client_scripts/zzz_delightify_level_generated.js`
- `kubejs/.delightify-level-generated.json`

带 `@delightify-level-generated` 标记。不覆盖手写脚本。须由调用方确认后再写。

当前接到 CLI 的只有 `graph` 与 `embed`。其余在 `@delightify/core`，尚未挂到 `agent-query`。

## 边界

- 不做桌面工作台，不做应用内对话 Agent。
- 不做设计/平衡判断。模型可以查世界、出变更预览；改多少、并成谁，由作者在自己的 harness 里定。
- 不要把整份 `project.db` 塞进上下文，用查询取片段。

完整的设计取舍与路线图见 [`design.md`](./design.md)。
