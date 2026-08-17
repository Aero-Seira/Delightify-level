/**
 * Mod types - v2.1
 * 
 * 根据 reference_sql/export.sqlite 样例调整
 */

/** 模组信息（与附属Mod导出结构一致） */
export interface Mod {
  /** 模组ID */
  modid: string;
  /** 版本号 */
  version?: string;
  /** 显示名称 */
  name?: string;
}

/** Mod 数据导入结果 */
export interface ModDataImportResult {
  /** 是否成功 */
  success: boolean;
  /** 导入记录ID */
  importId?: string;
  /** 数据源类型 */
  sourceKind?: DataSourceKind;
  /** 项目能力 */
  capabilities?: ProjectCapabilities;
  /** 导入统计 */
  stats?: {
    modCount: number;
    itemCount: number;
    recipeCount: number;
    tagCount: number;
  };
  /** 错误信息 */
  error?: string;
}

/** 导入进度 */
export interface ModDataImportProgress {
  /** 导入阶段 */
  phase: 'detecting' | 'reading' | 'validating' | 'importing' | 'completed' | 'error';
  /** 进度百分比 (0-100) */
  percent: number;
  /** 状态消息 */
  message: string;
  /** 当前处理的表 */
  currentTable?: string;
  /** 已处理数量 */
  processedCount?: number;
  /** 总数量 */
  totalCount?: number;
}

/** 数据导入历史记录 */
export interface DataImportHistory {
  /** 导入记录ID */
  importId: string;
  /** 数据源文件路径 */
  sourceFilePath: string;
  /** 数据源类型 */
  sourceKind?: DataSourceKind;
  /** 数据版本 */
  dataVersion: string;
  /** schema 版本 */
  schemaVersion?: string;
  /** 项目能力 */
  capabilities?: ProjectCapabilities;
  /** 模组列表哈希 */
  modlistHash?: string;
  /** 附属Mod导出时间 */
  exportedAt?: string;
  /** 导入的模组数量 */
  modCount: number;
  /** 导入的物品数量 */
  itemCount: number;
  /** 导入的配方数量 */
  recipeCount: number;
  /** 导入的标签数量 */
  tagCount: number;
  /** 导入时间 */
  importedAt: string;
  /** 是否成功 */
  isSuccess: boolean;
  /** 错误信息 */
  errorMessage?: string;
}

/** 清单条目 */
export interface ManifestEntry {
  key: string;
  value: string;
}

/** 数据源类型 */
export type DataSourceKind = 'exporter_v1' | 'legacy_exporter';

/** 项目能力 */
export interface ProjectCapabilities {
  /** 是否支持浏览物品/配方数据 */
  browse: boolean;
  /** 是否支持 MVP-0 unify 工作流 */
  mvp0Unify: boolean;
  /** 能力受限原因 */
  reason?: string;
}

/** 验证结果 */
export interface ValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 数据版本 */
  version?: string;
  /** schema 版本 */
  schemaVersion?: string;
  /** 数据源类型 */
  sourceKind?: DataSourceKind;
  /** 项目能力 */
  capabilities?: ProjectCapabilities;
  /** loader 类型 */
  loader?: string;
  /** Minecraft 版本，兼容 v1 manifest.mc_version */
  mcVersion?: string;
  /** 模组列表哈希 */
  modlistHash?: string;
  /** Minecraft版本 */
  minecraftVersion?: string;
  /** Forge版本 */
  forgeVersion?: string;
  /** 导出时间 */
  exportedAt?: string;
  /** 模组数量 */
  modCount?: number;
  /** 物品数量 */
  itemCount?: number;
  /** 配方数量 */
  recipeCount?: number;
  /** 标签关联数量 */
  tagCount?: number;
  /** 错误信息 */
  error?: string;
}
