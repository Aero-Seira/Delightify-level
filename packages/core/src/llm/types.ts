/**
 * LLM Service Types
 * 
 * 定义 LLM 服务的通用类型和接口
 */

/**
 * LLM 提供商类型
 */
export type LLMProvider = 'openai' | 'anthropic' | 'ollama';

/**
 * LLM 模型配置
 */
export interface LLMModelConfig {
  /** 提供商 */
  provider: LLMProvider;
  /** 模型名称 */
  model: string;
  /** API 端点（仅 Ollama 需要） */
  endpoint?: string;
  /** API Key（云端需要） */
  apiKey?: string;
  /** 最大 Tokens */
  maxTokens?: number;
  /** 温度（某些模型不支持，可不设置） */
  temperature?: number;
  /** 超时时间（毫秒） */
  timeout: number;
}

/**
 * LLM 请求消息
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM 请求选项
 */
export interface LLMRequestOptions {
  /** 覆盖默认模型配置 */
  modelConfig?: Partial<LLMModelConfig>;
  /** 是否流式输出 */
  stream?: boolean;
  /** 流式回调 */
  onStream?: (chunk: string) => void;
}

/**
 * LLM 响应
 */
export interface LLMResponse {
  /** 生成的内容 */
  content: string;
  /** 使用的模型 */
  model: string;
  /** 消耗的 Tokens */
  usage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  /** 响应时间（毫秒） */
  responseTime: number;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * 降级策略
 */
export interface FallbackStrategy {
  /** 主模型失败时的行为 */
  onPrimaryFailure: 'fallback' | 'abort';
  /** 超时时的行为 */
  onTimeout: 'fallback' | 'retry' | 'abort';
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔（毫秒） */
  retryDelay: number;
}

/**
 * LLM 模式配置（平等选项）
 */
export interface LLMProfile {
  /** 模式 ID */
  id: string;
  /** 模式名称 */
  name: string;
  /** 提供商类型 */
  provider: LLMProvider;
  /** 模型名称 */
  model: string;
  /** API 端点（Ollama / OpenAI 兼容服务需要） */
  endpoint?: string;
  /** API Base URL（所有连接都要有） */
  baseUrl?: string;
  /** HTTP 接口：chat/completions、responses、completions、Ollama 原生、Anthropic Messages */
  apiProtocol?: 'chat_completions' | 'responses' | 'completions' | 'ollama_chat' | 'anthropic_messages';
  /** API Key（云端需要） */
  apiKey?: string;
  /** 最大 Tokens */
  maxTokens?: number;
  /** 温度（某些模型如 Kimi 不支持，可不设置） */
  temperature?: number;
  /** Embedding 模型（可选；不设置时用 provider 默认，如 text-embedding-3-small） */
  embeddingModel?: string;
  /** 超时时间（毫秒） */
  timeout: number;
}

/**
 * LLM 服务配置
 */
export interface LLMServiceConfig {
  /** 当前激活的模式 ID */
  activeProfile: string;
  /** 可用模式列表 */
  profiles: LLMProfile[];
  /** 是否启用缓存 */
  enableCache: boolean;
  /** 缓存目录 */
  cacheDir?: string;
}

/**
 * 代码分析请求
 */
export interface CodeAnalysisRequest {
  /** 模组 ID */
  modId: string;
  /** 代码片段 */
  code: string;
  /** 分析类型 */
  analysisType: 'feature_extraction' | 'full_parse' | 'pattern_recognition';
  /** 额外上下文 */
  context?: {
    loader?: string;
    mcVersion?: string;
    className?: string;
  };
}

/**
 * 代码分析结果
 */
export interface CodeAnalysisResult {
  /** 加载器类型 */
  loaderType: 'forge' | 'fabric' | 'neoforge' | 'unknown';
  /** 版本 */
  version?: string;
  /** 注册模式 */
  registrationPattern: 'deferred_register' | 'static_field' | 'method_call' | 'dynamic' | 'unknown';
  /** 注册类型 */
  registryType: 'items' | 'blocks' | 'both' | 'unknown';
  /** 是否混淆 */
  isObfuscated: boolean;
  /** 置信度 */
  confidence: number;
  /** 提取的物品 */
  items?: Array<{
    id: string;
    className: string;
    isBlockItem?: boolean;
  }>;
  /** 提取的方块 */
  blocks?: Array<{
    id: string;
    className: string;
  }>;
  /** 备注 */
  notes?: string;
  /** 原始响应 */
  rawResponse?: string;
}

/**
 * LLM 服务接口
 */
export interface ILLMService {
  /**
   * 发送对话请求
   */
  chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  
  /**
   * 分析代码
   */
  analyzeCode(request: CodeAnalysisRequest): Promise<CodeAnalysisResult>;
  
  /**
   * 检查服务是否可用（当前激活的模式）
   */
  healthCheck(): Promise<boolean>;
  
  /**
   * 获取当前配置
   */
  getConfig(): LLMServiceConfig;
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<LLMServiceConfig>): void;
  
  /**
   * 获取当前激活的模式
   */
  getActiveProfile(): LLMProfile;
  
  /**
   * 切换激活的模式（由用户手动选择）
   */
  switchProfile(profileId: string): boolean;
  
  /**
   * 获取所有可用模式
   */
  getProfiles(): LLMProfile[];
  
  /**
   * 添加新模式
   */
  addProfile(profile: Omit<LLMProfile, 'id'>): LLMProfile;
  
  /**
   * 删除模式
   */
  removeProfile(profileId: string): boolean;
  
  /**
   * 更新模式配置
   */
  updateProfile(profileId: string, updates: Partial<Omit<LLMProfile, 'id'>>): boolean;
}

/**
 * 缓存条目
 */
export interface CacheEntry {
  key: string;
  result: CodeAnalysisResult;
  timestamp: number;
  model: string;
}
