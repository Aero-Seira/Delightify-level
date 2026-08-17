/**
 * Base LLM Provider
 * 
 * 所有 LLM 提供商的基类
 */

import type { LLMModelConfig, LLMMessage, LLMResponse, LLMRequestOptions } from '../types';

export abstract class BaseLLMProvider {
  protected config: LLMModelConfig;

  constructor(config: LLMModelConfig) {
    this.config = {
      ...config,
      maxTokens: config.maxTokens ?? 4096,
      // temperature 不设置默认值，由子类决定是否发送
      timeout: config.timeout ?? 600000,
    };
  }

  /**
   * 发送聊天请求（子类必须实现）
   */
  abstract chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;

  /**
   * 生成文本向量（可选能力；不支持的 provider 不实现，
   * 调用方需先判断 `typeof provider.embed === 'function'`）
   */
  embed?(texts: string[], model?: string): Promise<number[][]>;

  /**
   * 默认 embedding 模型（可选；实现了 embed 的 provider 应给出）
   */
  readonly defaultEmbeddingModel?: string;

  /**
   * 健康检查（子类必须实现）
   */
  abstract healthCheck(): Promise<boolean>;

  /**
   * 构建请求体（子类可以覆盖）
   */
  protected buildRequestBody(messages: LLMMessage[], options?: LLMRequestOptions): unknown {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
    };
    
    const maxTokens = options?.modelConfig?.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }
    
    const temperature = options?.modelConfig?.temperature ?? this.config.temperature;
    if (temperature !== undefined) {
      body.temperature = temperature;
    }
    
    return body;
  }

  /**
   * 带超时的 fetch
   */
  protected async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * 解析错误信息
   */
  protected parseError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
