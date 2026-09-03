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
  | 'llm'
  | 'agent-policy'
  | 'agent-tools'
  | 'commands-skills'
  | 'notification-background'
  | 'about';

export interface MobileSettingsCategory {
  id: MobileSettingsCategoryId;
  title: string;
  description: string;
}

export const MOBILE_SETTINGS_CATEGORIES: readonly MobileSettingsCategory[] = [
  {
    id: 'appearance',
    title: '外观与显示',
    description: '终端配色、字号、字体与对话呈现',
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
    id: 'agent-tools',
    title: 'Agent 工具',
    description: '联网搜索、网页抓取与搜索 API',
  },
  {
    id: 'commands-skills',
    title: '快捷命令与技能',
    description: '管理终端快捷命令与 Agent 技能',
  },
  {
    id: 'notification-background',
    title: '通知与后台',
    description: 'Agent 事件提醒与后台保活（仅 Android）',
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
