import { describe, expect, it } from 'vitest';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_SECTIONS,
  getSettingsCategoryLabel,
} from './settingsNavigation';

describe('settingsNavigation', () => {
  it('keeps category metadata and section lookup in sync', () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(SETTINGS_CATEGORY_SECTIONS[category.id]).toEqual(category.sections);
      expect(category.sections.length).toBeGreaterThan(0);
    }
  });

  it('exposes the settings sections needed for cross-category search', () => {
    const allSections = SETTINGS_CATEGORIES.flatMap((category) => category.sections);

    expect(allSections).toContain('settings-appearance');
    expect(allSections).toContain('settings-display');
    expect(allSections).toContain('settings-llm');
    expect(allSections).toContain('settings-command-policy');
    expect(allSections).toContain('settings-experimental');
    expect(allSections).toContain('settings-transfer');
    expect(allSections).toContain('settings-about');
  });

  it('labels known categories and falls back for unknown category ids', () => {
    expect(getSettingsCategoryLabel('transfer')).toBe('文件传输');
    expect(getSettingsCategoryLabel('model')).toBe('模型');
    expect(getSettingsCategoryLabel('missing')).toBe('设置');
  });
});
