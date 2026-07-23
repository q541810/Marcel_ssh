import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import type { AppSettings, TerminalColors } from '@/lib/types';

/**
 * Force high-contrast selection on mobile terminals.
 * Dark zinc selection blends into the canvas; indigo + white stays readable.
 * Display-only override — does not rewrite saved settings.
 */
export function withMobileSelectionContrast(
  colors: TerminalColors,
): TerminalColors {
  return {
    ...colors,
    selectionBackground: '#6366f1',
    selectionForeground: '#ffffff',
  };
}

export type MobileSettingsCategoryId =
  | 'appearance'
  | 'display'
  | 'llm'
  | 'agent-policy'
  | 'quick-commands'
  | 'skills'
  | 'sync'
  | 'about';

export interface MobileSettingsCategory {
  id: MobileSettingsCategoryId;
  title: string;
  description: string;
}

export const MOBILE_SETTINGS_CATEGORIES: readonly MobileSettingsCategory[] = [
  {
    id: 'appearance',
    title: '终端外观',
    description: '字号、字体与配色',
  },
  {
    id: 'display',
    title: '对话显示',
    description: '控制 Agent 对话内容的呈现方式',
  },
  {
    id: 'llm',
    title: '模型服务',
    description: 'API 与模型配置',
  },
  {
    id: 'agent-policy',
    title: 'Agent 策略',
    description: '命令安全边界、审批与执行限制',
  },
  {
    id: 'quick-commands',
    title: '快捷命令',
    description: '管理终端快捷命令',
  },
  {
    id: 'skills',
    title: 'Skills',
    description: '导入、编辑与启用技能',
  },
  {
    id: 'sync',
    title: '跨设备同步',
    description: '自动同步配置与聊天记录',
  },
  {
    id: 'about',
    title: '关于',
    description: '版本信息与检查更新',
  },
] as const;

export function getMobileSettingsCategory(
  id: string,
): MobileSettingsCategory | undefined {
  return MOBILE_SETTINGS_CATEGORIES.find((c) => c.id === id);
}

export function isMobileSettingsCategoryId(
  id: string,
): id is MobileSettingsCategoryId {
  return MOBILE_SETTINGS_CATEGORIES.some((c) => c.id === id);
}

export interface TerminalAppearanceResolved {
  fontSize: number;
  fontFamily: string;
  terminalColors: TerminalColors;
}

export function resolveTerminalAppearance(
  settings: Pick<AppSettings, 'fontSize' | 'fontFamily' | 'terminalColors'>,
  preview: Partial<AppSettings> | null | undefined,
): TerminalAppearanceResolved {
  const base =
    preview?.terminalColors ??
    settings.terminalColors ??
    DEFAULT_TERMINAL_COLORS;
  return {
    fontSize: preview?.fontSize ?? settings.fontSize,
    fontFamily: preview?.fontFamily ?? settings.fontFamily,
    terminalColors: withMobileSelectionContrast(base),
  };
}
