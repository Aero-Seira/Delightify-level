/**
 * LLM Service
 * 
 * 统一的 LLM 服务入口，支持多模式（平等选项）配置
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
} from './providers';
import type {
  LLMServiceConfig,
  LLMProfile,
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  CodeAnalysisRequest,
  CodeAnalysisResult,
  ILLMService,
  CacheEntry,
  LLMProvider,
} from './types';

// 内部使用的提供商类型
interface ProviderInstance {
  id: string;
  provider: OpenAIProvider | AnthropicProvider | OllamaProvider;
  profile: LLMProfile;
}

/**
 * 创建默认配置
 * 包含 Ollama 本地和 API 两种平等选项
 */
export function createDefaultConfig(): LLMServiceConfig {
  const profiles: LLMProfile[] = [
    {
      id: 'ollama-local',
      name: 'Ollama (本地)',
      provider: 'ollama',
      model: 'qwen2.5-coder:14b',
      endpoint: 'http://localhost:11434',
      maxTokens: 4096,
      temperature: 0.3,
      timeout: 600000, // 10 分钟，本地模型可能更慢
    },
    {
      id: 'openai-api',
      name: 'OpenAI API',
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: '',
      // 不设置 temperature，某些模型（如 Kimi）不支持
      timeout: 300000, // 5 分钟，处理大量代码需要更长时间
    },
    {
      id: 'anthropic-api',
      name: 'Anthropic Claude',
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      apiKey: '',
      maxTokens: 4096,
      timeout: 300000, // 5 分钟
    },
  ];

  return {
    activeProfile: 'ollama-local',
    profiles,
    enableCache: true,
    cacheDir: '',
  };
}

/**
 * 从环境变量创建配置
 * 如果检测到 API Key，会自动添加/更新对应的模式
 */
export function createConfigFromEnv(): LLMServiceConfig {
  const config = createDefaultConfig();
  
  // 从环境变量更新配置
  if (process.env.OPENAI_API_KEY) {
    const openaiProfile = config.profiles.find(p => p.id === 'openai-api');
    if (openaiProfile) {
      openaiProfile.apiKey = process.env.OPENAI_API_KEY;
      openaiProfile.model = process.env.OPENAI_MODEL || openaiProfile.model;
      if (process.env.OPENAI_BASE_URL) {
        openaiProfile.baseUrl = process.env.OPENAI_BASE_URL;
        console.log('[LLMService] Loaded OpenAI config from env:', openaiProfile.model, 'baseUrl:', openaiProfile.baseUrl);
      } else {
        console.log('[LLMService] Loaded OpenAI config from env:', openaiProfile.model);
      }
      if (process.env.OPENAI_EMBEDDING_MODEL) {
        openaiProfile.embeddingModel = process.env.OPENAI_EMBEDDING_MODEL;
      }
      // 如果配置了 OpenAI API Key，自动切换到 OpenAI 模式（除非明确指定了其他模式）
      if (!process.env.LLM_ACTIVE_PROFILE) {
        config.activeProfile = 'openai-api';
        console.log('[LLMService] Auto-switched to openai-api profile');
      }
    }
  }
  
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropicProfile = config.profiles.find(p => p.id === 'anthropic-api');
    if (anthropicProfile) {
      anthropicProfile.apiKey = process.env.ANTHROPIC_API_KEY;
      anthropicProfile.model = process.env.ANTHROPIC_MODEL || anthropicProfile.model;
      console.log('[LLMService] Loaded Anthropic config from env:', anthropicProfile.model);
      // 如果没有配置 OpenAI 且没有明确指定模式，切换到 Anthropic
      if (!process.env.OPENAI_API_KEY && !process.env.LLM_ACTIVE_PROFILE) {
        config.activeProfile = 'anthropic-api';
        console.log('[LLMService] Auto-switched to anthropic-api profile');
      }
    }
  }
  
  if (process.env.OLLAMA_ENDPOINT) {
    const ollamaProfile = config.profiles.find(p => p.id === 'ollama-local');
    if (ollamaProfile) {
      ollamaProfile.endpoint = process.env.OLLAMA_ENDPOINT;
      if (process.env.OLLAMA_MODEL) {
        ollamaProfile.model = process.env.OLLAMA_MODEL;
      }
      if (process.env.OLLAMA_EMBEDDING_MODEL) {
        ollamaProfile.embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL;
      }
      console.log('[LLMService] Loaded Ollama config from env:', ollamaProfile.endpoint);
    }
  }
  
  // 如果显式配置了激活的模式，使用它
  if (process.env.LLM_ACTIVE_PROFILE) {
    config.activeProfile = process.env.LLM_ACTIVE_PROFILE;
  }
  
  return config;
}

/**
 * LLM 服务实现
 */
export class LLMService implements ILLMService {
  private config: LLMServiceConfig;
  private providers: Map<string, ProviderInstance> = new Map();
  private cache: Map<string, CacheEntry> = new Map();

  constructor(config: LLMServiceConfig) {
    this.config = config;
    
    // 为所有模式创建提供商实例
    for (const profile of config.profiles) {
      this.createProviderForProfile(profile);
    }

    // 加载缓存
    if (config.enableCache && config.cacheDir) {
      this.loadCache();
    }
  }

  /**
   * 为指定模式创建提供商实例
   */
  private createProviderForProfile(profile: LLMProfile): ProviderInstance {
    let provider: OpenAIProvider | AnthropicProvider | OllamaProvider;
    
    switch (profile.provider) {
      case 'openai':
        provider = new OpenAIProvider({
          apiKey: profile.apiKey || '',
          model: profile.model,
          baseUrl: profile.baseUrl,
          apiProtocol: profile.apiProtocol,
          temperature: profile.temperature,
          timeout: profile.timeout,
        });
        break;
      case 'anthropic':
        provider = new AnthropicProvider({
          apiKey: profile.apiKey || '',
          model: profile.model,
          baseUrl: profile.baseUrl,
          timeout: profile.timeout,
        });
        break;
      case 'ollama':
        if (profile.apiProtocol === 'chat_completions') {
          provider = new OpenAIProvider({
            apiKey: profile.apiKey || '',
            model: profile.model,
            baseUrl: profile.baseUrl || profile.endpoint,
            apiProtocol: 'chat_completions',
            temperature: profile.temperature,
            timeout: profile.timeout,
          });
        } else {
          provider = new OllamaProvider({
            model: profile.model,
            baseUrl: profile.baseUrl,
            endpoint: profile.endpoint,
          });
        }
        break;
      default:
        throw new Error(`Unknown provider: ${(profile as LLMProfile).provider}`);
    }

    const instance: ProviderInstance = {
      id: profile.id,
      provider,
      profile,
    };
    
    this.providers.set(profile.id, instance);
    return instance;
  }

  /**
   * 获取当前激活的提供商实例
   */
  private getActiveProvider(): ProviderInstance {
    const active = this.providers.get(this.config.activeProfile);
    if (!active) {
      // 如果激活的模式不存在，使用第一个可用模式
      const first = this.providers.values().next().value;
      if (first) {
        console.warn(`[LLMService] Active profile '${this.config.activeProfile}' not found, falling back to '${first.id}'`);
        this.config.activeProfile = first.id;
        return first;
      }
      throw new Error('No LLM profiles configured');
    }
    return active;
  }

  /**
   * 发送聊天请求
   * 只使用用户选择的当前模式，失败时不自动回退
   */
  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    // 只使用当前激活的模式
    const activeProvider = this.getActiveProvider();
    
    const result = await activeProvider.provider.chat(messages, options);
    
    if (result.success) {
      return result;
    }
    
    // 失败时直接返回错误，不尝试其他模式
    console.warn(`[LLMService] Profile '${activeProvider.id}' failed:`, result.error);
    return {
      content: '',
      model: activeProvider.profile.model,
      responseTime: result.responseTime,
      success: false,
      error: `[${activeProvider.profile.name}] ${result.error || 'Request failed'}`,
    };
  }

  /**
   * 生成文本向量
   * 只使用当前激活的模式；provider 不支持 embed（如 Anthropic）时抛错。
   * 返回顺序与输入一致。模型解析顺序：入参 > profile.embeddingModel > provider 默认。
   */
  async embed(texts: string[], model?: string): Promise<{ model: string; vectors: number[][] }> {
    const activeProvider = this.getActiveProvider();
    if (typeof activeProvider.provider.embed !== 'function') {
      throw new Error(`Profile '${activeProvider.id}' (${activeProvider.profile.provider}) does not support embeddings`);
    }
    const resolvedModel =
      model ?? activeProvider.profile.embeddingModel ?? activeProvider.provider.defaultEmbeddingModel;
    if (!resolvedModel) {
      throw new Error(`Profile '${activeProvider.id}' has no embedding model configured`);
    }
    const vectors = await activeProvider.provider.embed(texts, resolvedModel);
    return { model: `${activeProvider.profile.provider}/${resolvedModel}`, vectors };
  }

  /**
   * 分析代码
   */
  async analyzeCode(request: CodeAnalysisRequest): Promise<CodeAnalysisResult> {
    // 生成缓存键（包含模式 ID，避免不同模式间的缓存混淆）
    const activeProfile = this.getActiveProvider();
    const cacheKey = this.generateCacheKey(request, activeProfile.id);
    
    // 检查缓存
    if (this.config.enableCache) {
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        console.log('[LLMService] Using cached result');
        return cached;
      }
    }

    // 构建 Prompt
    const prompt = this.buildAnalysisPrompt(request);
    
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: '你是一个 Minecraft 模组开发专家，擅长分析 Java/Kotlin 代码中的物品和方块注册模式。请只输出 JSON 格式，不要添加任何解释。',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await this.chat(messages);
    
    if (!response.success) {
      return {
        loaderType: 'unknown',
        registrationPattern: 'unknown',
        registryType: 'unknown',
        isObfuscated: false,
        confidence: 0,
        rawResponse: response.error,
      };
    }

    // 解析 JSON 结果
    let result: CodeAnalysisResult;
    try {
      // 尝试直接解析
      result = JSON.parse(response.content);
    } catch {
      // 尝试提取 JSON 部分
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          result = JSON.parse(jsonMatch[0]);
        } catch {
          result = {
            loaderType: 'unknown',
            registrationPattern: 'unknown',
            registryType: 'unknown',
            isObfuscated: false,
            confidence: 0,
            rawResponse: response.content,
          };
        }
      } else {
        result = {
          loaderType: 'unknown',
          registrationPattern: 'unknown',
          registryType: 'unknown',
          isObfuscated: false,
          confidence: 0,
          rawResponse: response.content,
        };
      }
    }

    // 缓存结果
    if (this.config.enableCache && result.confidence > 0.5) {
      this.cacheResult(cacheKey, result, activeProfile.profile.model);
    }

    return result;
  }

  /**
   * 构建分析 Prompt
   */
  private buildAnalysisPrompt(request: CodeAnalysisRequest): string {
    const { modId, code, analysisType, context } = request;
    
    let prompt = `分析以下 Minecraft 模组代码：\n\n`;
    prompt += `模组 ID: ${modId}\n`;
    if (context?.loader) prompt += `加载器: ${context.loader}\n`;
    if (context?.mcVersion) prompt += `MC 版本: ${context.mcVersion}\n`;
    if (context?.className) prompt += `类名: ${context.className}\n`;
    prompt += `\n代码:\n\`\`\`java\n${code}\n\`\`\`\n\n`;

    if (analysisType === 'feature_extraction') {
      prompt += `请识别注册模式特征，输出 JSON：\n`;
      prompt += `{\n`;
      prompt += `  "loaderType": "forge|fabric|neoforge|unknown",\n`;
      prompt += `  "version": "版本号或空",\n`;
      prompt += `  "registrationPattern": "deferred_register|static_field|method_call|dynamic|unknown",\n`;
      prompt += `  "registryType": "items|blocks|both|unknown",\n`;
      prompt += `  "isObfuscated": true|false,\n`;
      prompt += `  "confidence": 0.0-1.0,\n`;
      prompt += `  "notes": "额外说明"\n`;
      prompt += `}`;
    } else if (analysisType === 'full_parse') {
      prompt += `请提取所有物品和方块，输出 JSON：\n`;
      prompt += `{\n`;
      prompt += `  "loaderType": "forge|fabric|neoforge|unknown",\n`;
      prompt += `  "items": [\n`;
      prompt += `    {\n`;
      prompt += `      "id": "modid:item_name",\n`;
      prompt += `      "className": "完整类名",\n`;
      prompt += `      "isBlockItem": true|false\n`;
      prompt += `    }\n`;
      prompt += `  ],\n`;
      prompt += `  "blocks": [\n`;
      prompt += `    {\n`;
      prompt += `      "id": "modid:block_name",\n`;
      prompt += `      "className": "完整类名"\n`;
      prompt += `    }\n`;
      prompt += `  ],\n`;
      prompt += `  "confidence": 0.0-1.0,\n`;
      prompt += `  "notes": "额外说明"\n`;
      prompt += `}`;
    }

    return prompt;
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(request: CodeAnalysisRequest, profileId?: string): string {
    const data = `${profileId || 'default'}:${request.modId}:${request.analysisType}:${request.code}`;
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * 获取缓存结果
   */
  private getCachedResult(key: string): CodeAnalysisResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // 检查是否过期（7天）
    const now = Date.now();
    if (now - entry.timestamp > 7 * 24 * 60 * 60 * 1000) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.result;
  }

  /**
   * 缓存结果
   */
  private cacheResult(key: string, result: CodeAnalysisResult, model: string): void {
    this.cache.set(key, {
      key,
      result,
      timestamp: Date.now(),
      model,
    });
    
    // 异步保存到文件
    this.saveCache();
  }

  /**
   * 加载缓存
   */
  private loadCache(): void {
    if (!this.config.cacheDir) return;
    
    const cachePath = path.join(this.config.cacheDir, 'llm-cache.json');
    try {
      if (fs.existsSync(cachePath)) {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        for (const entry of data) {
          this.cache.set(entry.key, entry);
        }
        console.log(`[LLMService] Loaded ${this.cache.size} cached entries`);
      }
    } catch (error) {
      console.warn('[LLMService] Failed to load cache:', error);
    }
  }

  /**
   * 保存缓存
   */
  private saveCache(): void {
    if (!this.config.cacheDir) return;
    
    try {
      if (!fs.existsSync(this.config.cacheDir)) {
        fs.mkdirSync(this.config.cacheDir, { recursive: true });
      }
      
      const cachePath = path.join(this.config.cacheDir, 'llm-cache.json');
      const data = Array.from(this.cache.values());
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.warn('[LLMService] Failed to save cache:', error);
    }
  }

  /**
   * 健康检查（当前激活的模式）
   */
  async healthCheck(): Promise<boolean> {
    try {
      const active = this.getActiveProvider();
      return await active.provider.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * 检查指定模式的健康状态
   */
  async healthCheckProfile(profileId: string): Promise<boolean> {
    const instance = this.providers.get(profileId);
    if (!instance) return false;
    
    try {
      return await instance.provider.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * 获取配置
   */
  getConfig(): LLMServiceConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<LLMServiceConfig>): void {
    this.config = { ...this.config, ...config };
    
    // 如果 profiles 更新了，重新创建提供商
    if (config.profiles) {
      this.providers.clear();
      for (const profile of config.profiles) {
        this.createProviderForProfile(profile);
      }
    }
  }

  /**
   * 获取当前激活的模式
   */
  getActiveProfile(): LLMProfile {
    const active = this.getActiveProvider();
    return { ...active.profile };
  }

  /**
   * 获取所有可用模式
   */
  getProfiles(): LLMProfile[] {
    return this.config.profiles.map(p => ({ ...p }));
  }

  /**
   * 切换激活的模式
   */
  switchProfile(profileId: string): boolean {
    if (!this.providers.has(profileId)) {
      console.error(`[LLMService] Profile '${profileId}' not found`);
      return false;
    }
    
    this.config.activeProfile = profileId;
    console.log(`[LLMService] Switched to profile: ${profileId}`);
    return true;
  }

  /**
   * 添加新模式
   */
  addProfile(profile: Omit<LLMProfile, 'id'>): LLMProfile {
    const id = `profile-${Date.now()}`;
    const newProfile: LLMProfile = { ...profile, id };
    
    this.config.profiles.push(newProfile);
    this.createProviderForProfile(newProfile);
    
    return { ...newProfile };
  }

  /**
   * 删除模式
   */
  removeProfile(profileId: string): boolean {
    if (this.config.profiles.length <= 1) {
      console.error('[LLMService] Cannot remove the last profile');
      return false;
    }
    
    const index = this.config.profiles.findIndex(p => p.id === profileId);
    if (index === -1) return false;
    
    this.config.profiles.splice(index, 1);
    this.providers.delete(profileId);
    
    // 如果删除的是当前激活的模式，切换到第一个
    if (this.config.activeProfile === profileId && this.config.profiles.length > 0) {
      this.config.activeProfile = this.config.profiles[0].id;
    }
    
    return true;
  }

  /**
   * 更新模式配置
   */
  updateProfile(profileId: string, updates: Partial<Omit<LLMProfile, 'id'>>): boolean {
    const profile = this.config.profiles.find(p => p.id === profileId);
    if (!profile) return false;
    
    Object.assign(profile, updates);
    
    // 重新创建该模式的提供商
    this.providers.delete(profileId);
    this.createProviderForProfile(profile);
    
    return true;
  }
}

/**
 * 创建 LLM 服务实例
 * 
 * 配置优先级：
 * 1. 传入的 config 参数
 * 2. 环境变量
 * 3. 默认值
 */
export function createLLMService(config?: Partial<LLMServiceConfig>): LLMService {
  const envConfig = createConfigFromEnv();
  
  const finalConfig: LLMServiceConfig = {
    ...envConfig,
    ...config,
    profiles: config?.profiles || envConfig.profiles,
  } as LLMServiceConfig;

  return new LLMService(finalConfig);
}
