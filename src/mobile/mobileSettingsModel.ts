import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import {
  SETTINGS_PAGES,
  isSettingsPageId,
  type SettingsPage,
  type SettingsPageId,
} from '@/lib/settingsCatalog';
import { buildTerminalFontFamily } from '@/lib/terminalFont';
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

/** 页 id / 页名 / 分组 / 顺序与桌面共用同一份目录（`lib/settingsCatalog`），这里只管手机端的组合。 */
export type MobileSettingsCategoryId = SettingsPageId;

export type MobileSettingsCategory = SettingsPage;

export const MOBILE_SETTINGS_CATEGORIES: readonly MobileSettingsCategory[] =
  SETTINGS_PAGES;

export function getMobileSettingsCategory(
  id: string,
): MobileSettingsCategory | undefined {
  return MOBILE_SETTINGS_CATEGORIES.find((c) => c.id === id);
}

export function isMobileSettingsCategoryId(
  id: string,
): id is MobileSettingsCategoryId {
  return isSettingsPageId(id);
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
    // 与桌面同一套字体栈构造（内置 Nerd Font + monospace 兜底），见 lib/terminalFont.ts。
    fontFamily: buildTerminalFontFamily(preview?.fontFamily ?? settings.fontFamily),
    terminalColors: withMobileSelectionContrast(base),
  };
}
