import { describe, it, expect } from 'vitest';
import {
  MOBILE_SETTINGS_CATEGORIES,
  getMobileSettingsCategory,
  isMobileSettingsCategoryId,
  resolveTerminalAppearance,
} from './mobileSettingsModel';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import type { AppSettings } from '@/lib/types';

const baseSettings = {
  fontSize: 14,
  fontFamily: 'JetBrains Mono',
  terminalColors: DEFAULT_TERMINAL_COLORS,
} as AppSettings;

describe('MOBILE_SETTINGS_CATEGORIES', () => {
  it('lists only usable mobile categories in order', () => {
    expect(MOBILE_SETTINGS_CATEGORIES.map((c) => c.id)).toEqual([
      'appearance',
      'llm',
      'agent-policy',
      'commands-skills',
      'notification-background',
      'sync',
      'about',
    ]);
  });

  it('does not include the redundant agent-mode category', () => {
    // agent-mode duplicates the composer mode switch (same store, same persistence).
    expect(isMobileSettingsCategoryId('agent-mode')).toBe(false);
  });

  it('resolves category by id', () => {
    expect(getMobileSettingsCategory('llm')?.title).toBe('模型服务');
    expect(getMobileSettingsCategory('commands-skills')?.title).toBe('快捷命令与技能');
    expect(getMobileSettingsCategory('notification-background')?.title).toBe('通知与后台');
    expect(getMobileSettingsCategory('nope')).toBeUndefined();
  });

  it('isMobileSettingsCategoryId gates unknown ids', () => {
    expect(isMobileSettingsCategoryId('llm')).toBe(true);
    expect(isMobileSettingsCategoryId('plugins')).toBe(false);
    expect(isMobileSettingsCategoryId('agent-policy')).toBe(true);
    expect(isMobileSettingsCategoryId('commands-skills')).toBe(true);
    expect(isMobileSettingsCategoryId('notification-background')).toBe(true);
    // 已合并的旧 id 应被拒绝
    expect(isMobileSettingsCategoryId('display')).toBe(false);
    expect(isMobileSettingsCategoryId('quick-commands')).toBe(false);
    expect(isMobileSettingsCategoryId('skills')).toBe(false);
    expect(isMobileSettingsCategoryId('notification')).toBe(false);
    expect(isMobileSettingsCategoryId('background')).toBe(false);
  });
});

describe('resolveTerminalAppearance', () => {
  it('uses settings when no preview and forces high-contrast selection', () => {
    const result = resolveTerminalAppearance(baseSettings, null);
    expect(result.fontSize).toBe(14);
    expect(result.fontFamily).toBe('JetBrains Mono');
    expect(result.terminalColors.selectionBackground).toBe('#6366f1');
    expect(result.terminalColors.selectionForeground).toBe('#ffffff');
    // other palette fields preserved
    expect(result.terminalColors.background).toBe(
      DEFAULT_TERMINAL_COLORS.background,
    );
  });

  it('preview overrides individual fields', () => {
    const result = resolveTerminalAppearance(baseSettings, {
      fontSize: 18,
      fontFamily: 'Consolas',
    });
    expect(result.fontSize).toBe(18);
    expect(result.fontFamily).toBe('Consolas');
    expect(result.terminalColors.selectionBackground).toBe('#6366f1');
  });

  it('falls back to default colors when missing', () => {
    const noColors = { fontSize: 12, fontFamily: 'mono' } as AppSettings;
    const colors = resolveTerminalAppearance(noColors, null).terminalColors;
    expect(colors.background).toBe(DEFAULT_TERMINAL_COLORS.background);
    expect(colors.selectionBackground).toBe('#6366f1');
  });
});
