/**
 * OpenAI 及兼容协议
 *
 * 支持三条 HTTP 接口（与 Continue / Cline 一致）：
 * - chat_completions → POST {base}/chat/completions
 * - responses        → POST {base}/responses
 * - completions      → POST {base}/completions
 */

import { inferApiProtocol, resolveLlmModelsUrl, resolveLlmRequestUrl } from '@leveled/shared';
import { BaseLLMProvider } from './base';
import type { LLMMessage, LLMResponse, LLMRequestOptions } from '../types';

type OpenAiProtocol = 'chat_completions' | 'responses' | 'completions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractResponsesText(data: unknown): string {
  if (!isRecord(data)) return '';
  const helper = asString(data.output_text);
  if (helper) return helper;
  const output = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'output_text' || block.type === 'text') {
        parts.push(asString(block.text));
      }
    }
  }
  return parts.join('');
}

function messagesToPrompt(messages: LLMMessage[]): string {
  return `${messages.map((message) => {
    if (message.role === 'system') return message.content;
    if (message.role === 'user') return `User: ${message.content}`;
    return `Assistant: ${message.content}`;
  }).join('\n\n')}\n\nAssistant:`;
}

export class OpenAIProvider extends BaseLLMProvider {
  private baseUrl: string;
  private protocol: OpenAiProtocol;

  constructor(config: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    apiProtocol?: string;
    temperature?: number;
    timeout?: number;
  }) {
    super({
      provider: 'openai',
      model: config.model,
      apiKey: config.apiKey,
      maxTokens: 4096,
      temperature: config.temperature,
      timeout: config.timeout ?? 600000,
    });
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const inferred = inferApiProtocol({
      id: 'openai',
      name: 'openai',
      provider: 'openai',
      model: config.model,
      baseUrl: this.baseUrl,
      apiProtocol: config.apiProtocol === 'responses' || config.apiProtocol === 'completions'
        ? config.apiProtocol
        : config.apiProtocol === 'chat_completions'
          ? 'chat_completions'
          : undefined,
    });
    this.protocol = inferred === 'responses' || inferred === 'completions'
      ? inferred
      : 'chat_completions';
  }

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    try {
      if (this.protocol === 'responses') {
        return await this.chatResponses(messages, options, startTime);
      }
      if (this.protocol === 'completions') {
        return await this.chatCompletionsLegacy(messages, options, startTime);
      }
      return await this.chatCompletions(messages, options, startTime);
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
    const headers = this.authHeaders();
    try {
      const models = await this.fetchWithTimeout(
        resolveLlmModelsUrl(this.baseUrl, this.protocol),
        { method: 'GET', headers },
        8000,
      );
      if (models.ok) return true;
    } catch {
      // /models 很多兼容网关没有，改走一次极小生成
    }
    const ping = await this.chat(
      [{ role: 'user', content: 'ping' }],
      { modelConfig: { maxTokens: 8, timeout: 12000 } },
    );
    return ping.success;
  }

  readonly defaultEmbeddingModel = 'text-embedding-3-small';

  async embed(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchWithTimeout(
      resolveLlmRequestUrl(this.baseUrl, 'chat_completions').replace(/\/chat\/completions$/, '/embeddings'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          model: model ?? this.defaultEmbeddingModel,
          input: texts,
        }),
      },
      this.config.timeout,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embeddings API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const items = data.data ?? [];
    const vectors: number[][] = new Array(texts.length);
    for (const item of items) {
      vectors[item.index] = item.embedding;
    }
    if (vectors.some(vector => !vector)) {
      throw new Error(`OpenAI embeddings API returned ${items.length}/${texts.length} vectors`);
    }
    return vectors;
  }

  private authHeaders(): Record<string, string> {
    const key = this.config.apiKey?.trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async chatCompletions(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    startTime: number,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: options?.modelConfig?.model ?? this.config.model,
      messages,
    };
    const maxTokens = options?.modelConfig?.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined && maxTokens > 0) {
      body.max_tokens = maxTokens;
    }
    const temperature = options?.modelConfig?.temperature ?? this.config.temperature;
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const response = await this.fetchWithTimeout(
      resolveLlmRequestUrl(this.baseUrl, 'chat_completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
      },
      options?.modelConfig?.timeout ?? this.config.timeout,
    );
    if (!response.ok) {
      throw new Error(`OpenAI Chat Completions ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: data.model ?? this.config.model,
      usage: data.usage ? {
        prompt: data.usage.prompt_tokens ?? 0,
        completion: data.usage.completion_tokens ?? 0,
        total: data.usage.total_tokens ?? 0,
      } : undefined,
      responseTime: Date.now() - startTime,
      success: true,
    };
  }

  private async chatResponses(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    startTime: number,
  ): Promise<LLMResponse> {
    const system = messages.find(message => message.role === 'system')?.content;
    const input = messages.filter(message => message.role !== 'system');
    const body: Record<string, unknown> = {
      model: options?.modelConfig?.model ?? this.config.model,
      input,
      store: false,
    };
    if (system) {
      body.instructions = system;
    }
    const maxTokens = options?.modelConfig?.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined && maxTokens > 0) {
      body.max_output_tokens = maxTokens;
    }
    const temperature = options?.modelConfig?.temperature ?? this.config.temperature;
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const response = await this.fetchWithTimeout(
      resolveLlmRequestUrl(this.baseUrl, 'responses'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
      },
      options?.modelConfig?.timeout ?? this.config.timeout,
    );
    if (!response.ok) {
      throw new Error(`OpenAI Responses ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as {
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    return {
      content: extractResponsesText(data),
      model: data.model ?? this.config.model,
      usage: data.usage ? {
        prompt: inputTokens,
        completion: outputTokens,
        total: inputTokens + outputTokens,
      } : undefined,
      responseTime: Date.now() - startTime,
      success: true,
    };
  }

  private async chatCompletionsLegacy(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    startTime: number,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: options?.modelConfig?.model ?? this.config.model,
      prompt: messagesToPrompt(messages),
    };
    const maxTokens = options?.modelConfig?.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined && maxTokens > 0) {
      body.max_tokens = maxTokens;
    }
    const temperature = options?.modelConfig?.temperature ?? this.config.temperature;
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const response = await this.fetchWithTimeout(
      resolveLlmRequestUrl(this.baseUrl, 'completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
      },
      options?.modelConfig?.timeout ?? this.config.timeout,
    );
    if (!response.ok) {
      throw new Error(`OpenAI Completions ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as {
      model?: string;
      choices?: Array<{ text?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.text ?? '',
      model: data.model ?? this.config.model,
      usage: data.usage ? {
        prompt: data.usage.prompt_tokens ?? 0,
        completion: data.usage.completion_tokens ?? 0,
        total: data.usage.total_tokens ?? 0,
      } : undefined,
      responseTime: Date.now() - startTime,
      success: true,
    };
  }
}
