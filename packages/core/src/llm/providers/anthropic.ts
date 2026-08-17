/**
 * Anthropic (Claude) Provider
 * 
 * 支持 Claude API
 */

import { resolveLlmModelsUrl, resolveLlmRequestUrl } from '@leveled/shared';
import { BaseLLMProvider } from './base';
import type { LLMMessage, LLMResponse, LLMRequestOptions } from '../types';

export class AnthropicProvider extends BaseLLMProvider {
  private baseUrl: string;

  constructor(config: { apiKey: string; model: string; baseUrl?: string; timeout?: number }) {
    super({
      provider: 'anthropic',
      model: config.model,
      apiKey: config.apiKey,
      maxTokens: 4096,
      temperature: 0.3,
      timeout: config.timeout ?? 600000,
    });
    this.baseUrl = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  }

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    const startTime = Date.now();

    try {
      // 转换消息格式：Claude 使用 system 参数
      const systemMessage = messages.find(m => m.role === 'system')?.content;
      const conversationMessages = messages.filter(m => m.role !== 'system');

      // 构建请求体
      const requestBody: Record<string, unknown> = {
        model: options?.modelConfig?.model ?? this.config.model,
        max_tokens: options?.modelConfig?.maxTokens ?? this.config.maxTokens ?? 4096,
        system: systemMessage,
        messages: conversationMessages,
      };
      
      // 只在指定时添加 temperature
      const temperature = options?.modelConfig?.temperature ?? this.config.temperature;
      if (temperature !== undefined) {
        requestBody.temperature = temperature;
      }
      
      const response = await this.fetchWithTimeout(
        resolveLlmRequestUrl(this.baseUrl, 'anthropic_messages'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
        },
        options?.modelConfig?.timeout ?? this.config.timeout
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const content = data.content?.[0]?.text || '';

      return {
        content,
        model: data.model,
        usage: data.usage ? {
          prompt: data.usage.input_tokens,
          completion: data.usage.output_tokens,
          total: data.usage.input_tokens + data.usage.output_tokens,
        } : undefined,
        responseTime: Date.now() - startTime,
        success: true,
      };
    } catch (error) {
      return {
        content: '',
        model: this.config.model,
        responseTime: Date.now() - startTime,
        success: false,
        error: this.parseError(error),
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // 发送一个极简单的请求来检查 API 是否可用
      const response = await this.fetchWithTimeout(
        resolveLlmModelsUrl(this.baseUrl, 'anthropic_messages'),
        {
          method: 'GET',
          headers: {
            'x-api-key': this.config.apiKey!,
            'anthropic-version': '2023-06-01',
          },
        },
        10000
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
