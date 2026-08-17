/**
 * App-wide user settings contract.
 *
 * Persisted by the main process in userData/settings.json. Renderer-local
 * theme/language stores remain as fast defaults, but settings.json is the
 * source of truth on startup.
 */

import type { Language } from './i18n';
import type { ThemeMode } from './theme';
import type { HealthMonitorSettings } from './health';

export type AgentDefaultMode = 'auto' | 'execute' | 'guided';
export type DefaultExportBackend = 'kubejs' | 'datapack' | 'almost_unified';
export type LLMProviderKind = 'openai' | 'anthropic' | 'ollama';

/** 设置页上的连接类型。openai-compat 落盘仍是 provider=openai。 */
export type LLMConnectionKind = 'ollama' | 'openai' | 'openai-compat' | 'anthropic';

/**
 * 实际请求走哪条 HTTP 接口。
 * 对齐 Continue / Cline / OpenCode：品牌和协议分开选。
 */
export type LLMApiProtocol =
  | 'chat_completions'
  | 'responses'
  | 'completions'
  | 'ollama_chat'
  | 'anthropic_messages';

export const LLM_API_PROTOCOLS: LLMApiProtocol[] = [
  'chat_completions',
  'responses',
  'completions',
  'ollama_chat',
  'anthropic_messages',
];

export interface LLMProfileSettings {
  id: string;
  name: string;
  provider: LLMProviderKind;
  model: string;
  /** 所有连接都要填。旧字段 endpoint 读入时会迁到这里。 */
  baseUrl?: string;
  /** @deprecated 仅兼容旧 settings.json，请用 baseUrl */
  endpoint?: string;
  /** Chat Completions / Responses / Completions / Ollama 原生 / Anthropic Messages */
  apiProtocol?: LLMApiProtocol;
  apiKey?: string;
  embeddingModel?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface LLMSettings {
  activeProfile: string;
  profiles: LLMProfileSettings[];
}

export interface AppSettings {
  version: 1;
  language: Language;
  theme: ThemeMode;
  llm: LLMSettings;
  knowledge: {
    /** 打开项目后自动执行的深度扫描 */
    deepScan: boolean;
    /** 是否允许把本地命中片段发送给云端知识 LLM（需用户显式授权） */
    allowCloudLocalContent: boolean;
    /** 知识问答是否启用 LLM（关闭时使用确定性证据回答） */
    llmEnabled: boolean;
  };
  agent: {
    defaultMode: AgentDefaultMode;
    allowCloud: boolean;
  };
  output: {
    defaultBackend: DefaultExportBackend;
  };
  health: HealthMonitorSettings;
}

export function defaultLLMProfiles(): LLMProfileSettings[] {
  return [createLLMProfile('ollama')];
}

export function defaultAppSettings(): AppSettings {
  return {
    version: 1,
    language: 'zh-CN',
    theme: 'dark',
    llm: (() => {
      const profiles = defaultLLMProfiles();
      return { activeProfile: profiles[0].id, profiles };
    })(),
    knowledge: {
      deepScan: true,
      allowCloudLocalContent: false,
      llmEnabled: false,
    },
    agent: {
      defaultMode: 'auto',
      allowCloud: false,
    },
    output: {
      defaultBackend: 'kubejs',
    },
    health: {
      monitorEnabled: true,
      intervalSeconds: 30,
      notifyOnChange: true,
      checkOnStartup: true,
    },
  };
}

export type SettingsUpdateParams = Partial<{
  language: Language;
  theme: ThemeMode;
  llm: Partial<LLMSettings>;
  knowledge: Partial<AppSettings['knowledge']>;
  agent: Partial<AppSettings['agent']>;
  output: Partial<AppSettings['output']>;
  health: Partial<AppSettings['health']>;
}>;

export interface LLMProfileSettingsStatus {
  id: string;
  name: string;
  provider: string;
  model: string;
  configured: boolean;
}

export interface SettingsPayload {
  settings: AppSettings;
  llm: {
    activeProfile: string;
    profiles: LLMProfileSettingsStatus[];
  };
  persistedPath: string;
}

export interface LLMTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  model?: string;
}

export function isLLMApiProtocol(value: unknown): value is LLMApiProtocol {
  return typeof value === 'string' && (LLM_API_PROTOCOLS as string[]).includes(value);
}

export function llmConnectionKind(profile: LLMProfileSettings): LLMConnectionKind {
  if (profile.provider === 'ollama') return 'ollama';
  if (profile.provider === 'anthropic') return 'anthropic';
  const url = resolveLlmBaseUrl(profile).toLowerCase();
  if (url && !url.includes('api.openai.com')) return 'openai-compat';
  return 'openai';
}

export function defaultBaseUrlForKind(kind: LLMConnectionKind): string {
  switch (kind) {
    case 'ollama':
      return 'http://localhost:11434';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'openai-compat':
      return '';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
  }
}

export function defaultApiProtocolForKind(kind: LLMConnectionKind): LLMApiProtocol {
  switch (kind) {
    case 'ollama':
      return 'ollama_chat';
    case 'openai':
      return 'responses';
    case 'openai-compat':
      return 'chat_completions';
    case 'anthropic':
      return 'anthropic_messages';
  }
}

export function allowedApiProtocols(kind: LLMConnectionKind): LLMApiProtocol[] {
  switch (kind) {
    case 'ollama':
      return ['ollama_chat', 'chat_completions'];
    case 'openai':
      return ['responses', 'chat_completions', 'completions'];
    case 'openai-compat':
      return ['chat_completions', 'responses', 'completions'];
    case 'anthropic':
      return ['anthropic_messages'];
  }
}

/** 已存盘但没写 protocol 时，保持旧行为（OpenAI 走 Chat Completions）。 */
export function inferApiProtocol(profile: LLMProfileSettings): LLMApiProtocol {
  if (isLLMApiProtocol(profile.apiProtocol)) {
    return profile.apiProtocol;
  }
  if (profile.provider === 'ollama') return 'ollama_chat';
  if (profile.provider === 'anthropic') return 'anthropic_messages';
  return 'chat_completions';
}

export function normalizeLlmBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function resolveLlmBaseUrl(profile: Pick<LLMProfileSettings, 'baseUrl' | 'endpoint'>): string {
  return normalizeLlmBaseUrl(profile.baseUrl || profile.endpoint || '');
}

function stripOpenAiVersionSuffix(base: string): string {
  return base.replace(/\/v\d+$/i, '');
}

/**
 * 把 Base URL 和具体资源拼成最终请求地址。
 * `https://api.openai.com/v1` + chat/completions
 * `http://localhost:11434` + chat/completions → 自动补 /v1
 * `http://localhost:11434` + ollama_chat → /api/chat
 */
export function resolveLlmRequestUrl(baseUrl: string, protocol: LLMApiProtocol): string {
  const base = normalizeLlmBaseUrl(baseUrl);
  if (!base) return '';

  if (protocol === 'ollama_chat') {
    const root = stripOpenAiVersionSuffix(base);
    if (root.endsWith('/api/chat')) return root;
    return `${root}/api/chat`;
  }

  const resource = protocol === 'responses'
    ? 'responses'
    : protocol === 'completions'
      ? 'completions'
      : protocol === 'anthropic_messages'
        ? 'messages'
        : 'chat/completions';

  if (base.endsWith(`/${resource}`)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/${resource}`;
  return `${base}/v1/${resource}`;
}

export function resolveLlmModelsUrl(baseUrl: string, protocol: LLMApiProtocol): string {
  const base = normalizeLlmBaseUrl(baseUrl);
  if (protocol === 'ollama_chat') {
    return `${stripOpenAiVersionSuffix(base)}/api/tags`;
  }
  if (/\/v\d+$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

export function isCloudLLMProfile(profile: { provider: string }): boolean {
  return profile.provider !== 'ollama';
}

export function isLLMProfileConfigured(profile: LLMProfileSettings): boolean {
  if (!profile.model.trim()) return false;
  if (!resolveLlmBaseUrl(profile)) return false;
  if (profile.provider === 'ollama') return true;
  return Boolean(profile.apiKey?.trim());
}

export function applyLLMConnectionKind(
  profile: LLMProfileSettings,
  kind: LLMConnectionKind,
): LLMProfileSettings {
  const previousKind = llmConnectionKind(profile);
  const keepUrl = previousKind === kind && resolveLlmBaseUrl(profile);
  const protocolAllowed = allowedApiProtocols(kind);
  const protocol = profile.apiProtocol && protocolAllowed.includes(profile.apiProtocol)
    ? profile.apiProtocol
    : defaultApiProtocolForKind(kind);

  switch (kind) {
    case 'ollama':
      return {
        ...profile,
        provider: 'ollama',
        baseUrl: keepUrl || defaultBaseUrlForKind(kind),
        endpoint: undefined,
        apiProtocol: protocol,
      };
    case 'openai':
      return {
        ...profile,
        provider: 'openai',
        baseUrl: keepUrl || defaultBaseUrlForKind(kind),
        endpoint: undefined,
        apiProtocol: protocol,
      };
    case 'openai-compat': {
      const url = resolveLlmBaseUrl(profile);
      const official = url.includes('api.openai.com');
      return {
        ...profile,
        provider: 'openai',
        baseUrl: !official && url ? url : '',
        endpoint: undefined,
        apiProtocol: protocol,
      };
    }
    case 'anthropic':
      return {
        ...profile,
        provider: 'anthropic',
        baseUrl: keepUrl || defaultBaseUrlForKind(kind),
        endpoint: undefined,
        apiProtocol: protocol,
      };
  }
}

export function createLLMProfile(kind: LLMConnectionKind): LLMProfileSettings {
  const id = `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const named: Record<LLMConnectionKind, Pick<LLMProfileSettings, 'name' | 'model'>> = {
    ollama: { name: '本地 Ollama', model: 'qwen2.5-coder:14b' },
    openai: { name: 'OpenAI', model: 'gpt-4.1-mini' },
    'openai-compat': { name: 'OpenAI 兼容', model: 'deepseek-chat' },
    anthropic: { name: 'Anthropic', model: 'claude-sonnet-4-5' },
  };
  return applyLLMConnectionKind({
    id,
    name: named[kind].name,
    provider: 'openai',
    model: named[kind].model,
    timeout: kind === 'ollama' ? 600000 : 300000,
  }, kind);
}
