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
      'model',
      'agent',
      'memory',
      'tools',
      'appearance',
      'notification',
      'sync',
      'about',
    ]);
  });

  it('does not include the redundant agent-mode category', () => {
    // agent-mode duplicates the composer mode switch (same store, same persistence).
    expect(isMobileSettingsCategoryId('agent-mode')).toBe(false);
  });

  it('resolves category by id', () => {
    expect(getMobileSettingsCategory('model')?.title).toBe('模型');
    expect(getMobileSettingsCategory('tools')?.title).toBe('工具与扩展');
    expect(getMobileSettingsCategory('appearance')?.title).toBe('外观与终端');
    expect(getMobileSettingsCategory('notification')?.title).toBe('通知');
    expect(getMobileSettingsCategory('sync')?.title).toBe('同步与会话');
    expect(getMobileSettingsCategory('nope')).toBeUndefined();
  });

  it('isMobileSettingsCategoryId gates unknown ids', () => {
    expect(isMobileSettingsCategoryId('model')).toBe(true);
    expect(isMobileSettingsCategoryId('tools')).toBe(true);
    expect(isMobileSettingsCategoryId('agent')).toBe(true);
    expect(isMobileSettingsCategoryId('notification')).toBe(true);
    // 手机没有的页 / 已合并的旧 id 应被拒绝
    expect(isMobileSettingsCategoryId('plugins')).toBe(false);
    expect(isMobileSettingsCategoryId('market')).toBe(false);
    expect(isMobileSettingsCategoryId('llm')).toBe(false);
    expect(isMobileSettingsCategoryId('agent-policy')).toBe(false);
    expect(isMobileSettingsCategoryId('agent-tools')).toBe(false);
    expect(isMobileSettingsCategoryId('commands-skills')).toBe(false);
    expect(isMobileSettingsCategoryId('notification-background')).toBe(false);
    expect(isMobileSettingsCategoryId('conversations')).toBe(false);
    expect(isMobileSettingsCategoryId('display')).toBe(false);
  });
});

describe('resolveTerminalAppearance', () => {
  it('uses settings when no preview and forces high-contrast selection', () => {
    const result = resolveTerminalAppearance(baseSettings, null);
    expect(result.fontSize).toBe(14);
    // 字体栈经 lib/terminalFont 构造：用户字体 + 内置 Nerd Font 兜底 + monospace。
    expect(result.fontFamily).toBe(
      'JetBrains Mono, "Marcel Nerd Font Mono", monospace',
    );
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
    expect(result.fontFamily).toBe('Consolas, "Marcel Nerd Font Mono", monospace');
    expect(result.terminalColors.selectionBackground).toBe('#6366f1');
  });

  it('falls back to default colors when missing', () => {
    const noColors = { fontSize: 12, fontFamily: 'mono' } as AppSettings;
    const colors = resolveTerminalAppearance(noColors, null).terminalColors;
    expect(colors.background).toBe(DEFAULT_TERMINAL_COLORS.background);
    expect(colors.selectionBackground).toBe('#6366f1');
  });
});
