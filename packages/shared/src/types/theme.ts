/**
 * Theme Type Definitions
 * Apple-style Light/Dark theme system
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeState {
  mode: ThemeMode;
  resolvedMode: 'light' | 'dark'; // 实际应用的模式（system 解析后）
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

// CSS 变量类型（用于类型提示）
export interface ThemeColors {
  // 背景
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  // 表面
  surfacePrimary: string;
  surfaceSecondary: string;
  // 强调色
  accent: string;
  accentHover: string;
  // 文字
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textPlaceholder: string;
  // 边框
  border: string;
  borderHover: string;
  // 阴影
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}

// 主题相关的翻译键
export interface ThemeTranslation {
  settings: {
    theme: string;
  };
  theme: {
    light: string;
    dark: string;
    system: string;
  };
}
