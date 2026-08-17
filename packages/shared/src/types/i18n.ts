// 支持的语言
export type Language = 'zh-CN' | 'en';

// 翻译函数类型
export type TranslateFunction = (key: string, params?: Record<string, string>) => string;

// i18n 状态接口
export interface I18nState {
  currentLanguage: Language;
  setLanguage: (lang: Language) => void;
  t: TranslateFunction;
}

// 嵌套翻译数据结构
type NestedTranslation = string | { [key: string]: NestedTranslation };

// 翻译数据结构
export type TranslationData = {
  [key: string]: NestedTranslation;
};
