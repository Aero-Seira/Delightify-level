/**
 * Recipe types - v2.2
 * 
 * 根据 reference_sql/export.sqlite 样例调整
 * 新增配方类型元数据系统
 */

// ============================================================================
// 配方类型元数据（来自 config/recipe_types/*.json）
// ============================================================================

/** 字段定义 */
export interface FieldSpec {
  /** 是否必填 */
  required: boolean;
  /** 字段类型 */
  type: 'string' | 'integer' | 'float' | 'boolean' | 'array' | 'object' | 'ingredient' | 'item_stack' | 'item_tag';
  /** 默认值 */
  default?: unknown;
  /** 描述 */
  description?: string;
  /** 常量值（如果指定，该字段只能是此值） */
  constant?: string;
  /** 数组最小长度 */
  minItems?: number;
  /** 数组最大长度 */
  maxItems?: number;
  /** 数值范围 [min, max] */
  range?: [number, number];
  /** 单位 */
  unit?: string;
}

/** 槽位定义 */
export interface SlotSpec {
  /** 槽位ID */
  slotId: string;
  /** 槽位类型 */
  type: 'input' | 'output' | 'catalyst' | 'fluid';
  /** 显示名称 */
  displayName?: string;
  /** 是否必需 */
  required: boolean;
  /** 是否支持标签 */
  acceptsTag?: boolean;
  /** 槽位位置（在网格中的行列） */
  position?: { row: number; col: number };
}

/** 适用场景 */
export interface SuitableFor {
  /** 适用的物品分类 */
  itemCategories?: string[];
  /** 关键词 */
  keywords?: string[];
  /** 输入数量范围 */
  inputCount?: { min: number; max: number };
  /** 输出数量范围 */
  outputCount?: { min: number; max: number };
  /** 典型模式描述 */
  typicalPatterns?: string[];
}

/** 配方类型元数据 */
export interface RecipeTypeMetadata {
  /** 配方类型ID (如 "minecraft:crafting_shaped") */
  recipeTypeId: string;
  /** 显示名称 */
  displayName: string;
  /** 描述 */
  description?: string;
  /** 图标物品ID */
  icon?: string;
  /** 配方模板 */
  template: Record<string, unknown>;
  /** 字段定义映射 */
  fieldSpecs: Record<string, FieldSpec>;
  /** 输入槽位定义 */
  inputSlots: SlotSpec[];
  /** 输出槽位定义 */
  outputSlots: SlotSpec[];
  /** 适用场景 */
  suitableFor?: SuitableFor;
  /** 所属模组ID */
  modId: string;
}

/** 配方类型配置文件结构 */
export interface RecipeTypeConfig {
  modInfo: {
    modId: string;
    modName: string;
    version?: string;
    description?: string;
  };
  recipeTypes: RecipeTypeMetadata[];
}

// ============================================================================
// 配方数据（来自数据库）
// ============================================================================

/** 配方信息（与附属Mod导出结构一致） */
export interface Recipe {
  /** 完整配方ID */
  recipeId: string;
  /** 配方类型ID (如 "minecraft:smoking") */
  typeId: string;
  /** 所属模组ID */
  modid: string;
  /** 配方哈希 */
  hash: string;
  /** 原始JSON */
  rawJson?: string;
  /** 是否未解析 */
  unparsed: boolean;
  /** 有序合成网格宽（槽位行主序 = row * inputWidth + col；非有序配方为空） */
  inputWidth?: number;
  /** 有序合成网格高 */
  inputHeight?: number;
}

/** 配方输入槽位视图 */
export interface RecipeInputView {
  /** 槽位序号 */
  slot: number;
  /** 槽位角色 */
  role: string;
  /** 引用类型 */
  kind: string;
  /** item/tag 引用 */
  ref?: string;
  /** 数量 */
  count: number;
  /** 显示名称 */
  displayName?: string;
}

/** 配方输出槽位视图 */
export interface RecipeOutputView {
  /** 槽位序号 */
  slot: number;
  /** 输出物品ID */
  itemId: string;
  /** 数量 */
  count: number;
  /** components JSON */
  componentsJson?: string;
  /** 是否主输出 */
  isPrimary: boolean;
  /** 显示名称 */
  displayName?: string;
}

/** 配方详情 */
export interface RecipeDetail {
  /** 配方基础信息 */
  recipe: Recipe;
  /** 结构化输入 */
  inputs: RecipeInputView[];
  /** 结构化输出 */
  outputs: RecipeOutputView[];
}

/** 配方查询参数 */
export interface RecipeQueryParams {
  /** 搜索关键词 */
  search?: string;
  /** 按模组筛选 */
  modid?: string;
  /** 按配方类型筛选 */
  typeId?: string;
  /** 页码 */
  page?: number;
  /** 每页数量 */
  pageSize?: number;
}

/** 配方类型信息 */
export interface RecipeTypeInfo {
  /** 配方类型ID */
  typeId: string;
  /** 显示名称（可自定义） */
  displayName: string;
  /** 配方数量 */
  recipeCount: number;
}

/** 配方分面计数参数（不含分页） */
export type RecipeFacetParams = Omit<RecipeQueryParams, 'page' | 'pageSize'>;

/** 配方分面计数结果：一次 IPC 返回全部 mod/类型计数，替代 N+1 查询 */
export interface RecipeFacetCounts {
  /** 各 mod 在当前搜索条件（排除 modId 筛选本身）下的配方数 */
  modCounts: Record<string, number>;
  /** 各配方类型在当前搜索条件（排除 typeId 筛选本身）下的配方数 */
  typeCounts: Record<string, number>;
}

/** 配方编辑记录 */
export interface RecipeEdit {
  /** 编辑记录ID */
  editId: string;
  /** 修改的配方ID */
  recipeId: string;
  /** 编辑类型 */
  editType: 'create' | 'modify' | 'disable' | 'delete' | 'restore';
  /** 原始配方（修改前） */
  originalRecipe?: string;
  /** 修改后的配方 */
  editedRecipe: string;
  /** 编辑说明 */
  description?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 是否已导出 */
  isExported: boolean;
  /** 导出时间 */
  exportedAt?: string;
}

/** 创建配方编辑请求 */
export interface CreateRecipeEditRequest {
  /** 配方ID */
  recipeId: string;
  /** 编辑类型 */
  editType: RecipeEdit['editType'];
  /** 原始配方JSON */
  originalRecipe?: string;
  /** 修改后的配方JSON */
  editedRecipe: string;
  /** 编辑说明 */
  description?: string;
}
