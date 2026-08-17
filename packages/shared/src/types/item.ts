/**
 * Item types - v2.1
 * 
 * 根据 reference_sql/export.sqlite 样例调整
 */

/** 物品/方块信息（与附属Mod导出结构一致） */
export interface Item {
  /** 完整ID (如 "minecraft:stone") */
  itemId: string;
  /** 所属模组ID */
  modid: string;
  /** 显示名称（来自 items.translation_key -> translations） */
  displayName?: string;
}

/** 标签信息（与附属Mod导出结构一致） */
export interface ItemTag {
  /** 标签ID (如 "forge:storage_blocks") */
  tagId: string;
  /** 物品ID */
  itemId: string;
}

/** 搜索字段类型 */
export type SearchField = 'id' | 'name' | 'tag' | 'all';

/** 物品查询参数 */
export interface ItemQueryParams {
  /** 搜索关键词 */
  search?: string;
  /** 显示语言 */
  lang?: string;
  /** 搜索字段类型：id=物品ID, name=翻译名, tag=标签, all=全部 */
  searchField?: SearchField;
  /** 按模组筛选 */
  modid?: string;
  /** 按标签筛选（精确匹配） */
  tagId?: string;
  /** 页码 */
  page?: number;
  /** 每页数量 */
  pageSize?: number;
}

/** 物品查询结果 */
export interface ItemQueryResult {
  /** 物品列表 */
  items: Item[];
  /** 总数 */
  total: number;
  /** 页码 */
  page: number;
  /** 每页数量 */
  pageSize: number;
}

/** 标签信息（聚合后） */
export interface TagInfo {
  /** 标签ID */
  tagId: string;
  /** 包含的物品数量 */
  itemCount: number;
}

/** 物品分面计数参数（不含分页） */
export type ItemFacetParams = Omit<ItemQueryParams, 'page' | 'pageSize'>;

/** 物品分面计数结果：一次 IPC 返回全部 mod/tag 计数，替代逐 mod/tag 的 N+1 查询 */
export interface ItemFacetCounts {
  /** 各 mod 在当前搜索条件（排除 modId 筛选本身）下的物品数 */
  modCounts: Record<string, number>;
  /** 各 tag 在当前搜索条件（排除 tagId 筛选本身）下的物品数 */
  tagCounts: Record<string, number>;
}

/** 战利品来源类别（契约 v2 派生） */
export type ItemLootCategory =
  | 'block'      // 方块掉落（精确绑定）
  | 'entity'     // 生物掉落（精确绑定）
  | 'chest'      // 箱子战利品
  | 'fishing'    // 钓鱼
  | 'bartering'  // 猪灵以物易物
  | 'archaeology'// 考古（刷扫）
  | 'spawner'    // 试炼刷怪笼
  | 'dispenser'  // 发射器
  | 'shearing'   // 剪取
  | 'pot'        // 陶罐
  | 'gameplay'   // 其他玩法（村民礼物、英雄之村等）
  | 'other';

/** 战利品产出的一次出现（保留原始 JSON 字段以便 UI 展示） */
export interface ItemLootOccurrence {
  /** pool 在表中的序号 */
  pool: number;
  /** 抽取次数（数字或 {min,max} 等 number provider，原样） */
  rolls?: unknown;
  /** set_count 的 count（若有，原样） */
  count?: unknown;
  /** 生效条件（pool 级 + 条目级原始 condition JSON） */
  conditions: unknown[];
}

/** 物品的一条获取来源 */
export interface ItemLootSource {
  category: ItemLootCategory;
  /** 方块/实体注册 ID（block/entity 类）或 loot_table_id（其他类） */
  sourceId: string;
  /** 产生该物品的战利品表 ID */
  lootTableId: string;
  /** 来源显示名（block/entity 可解析翻译时） */
  sourceName?: string;
  occurrences: ItemLootOccurrence[];
}
