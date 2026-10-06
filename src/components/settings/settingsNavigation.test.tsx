import { describe, expect, it } from 'vitest';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_SECTIONS,
  SETTINGS_SECTION_SPAN,
  getSettingsCategoryLabel,
} from './settingsNavigation';

/**
 * 源文件文本（vite raw glob，与 `turnState.test.ts` 同一手法）：section 要在三个地方
 * 注册（分类列表 / 列宽表 / SettingsContent 的组件表），漏一处就是「分类里点不到」
 * 或「搜索搜得到、渲染不出来」。
 */
const RAW = import.meta.glob(['/src/components/settings/SettingsContent.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const contentSource = RAW['/src/components/settings/SettingsContent.tsx'] ?? '';

describe('settingsNavigation', () => {
  it('keeps category metadata and section lookup in sync', () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(SETTINGS_CATEGORY_SECTIONS[category.id]).toEqual(category.sections);
      expect(category.sections.length).toBeGreaterThan(0);
    }
  });

  it('每个 section 都注册齐全：组件表 ↔ 分类列表 ↔ 列宽表', () => {
    expect(contentSource.length).toBeGreaterThan(0);
    const declared = SETTINGS_CATEGORIES.flatMap((category) => category.sections);

    for (const id of declared) {
      expect(contentSource, `${id} 没在 SettingsContent 里挂组件`).toContain(`id: '${id}'`);
      expect(SETTINGS_SECTION_SPAN[id], `${id} 没有列宽声明`).toBeDefined();
    }

    const registered = [...contentSource.matchAll(/id: '(settings-[a-z-]+)'/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);
    for (const id of registered) {
      expect(declared, `${id} 注册了却没挂进任何分类`).toContain(id);
    }
  });

  it('exposes the settings sections needed for cross-category search', () => {
    const allSections = SETTINGS_CATEGORIES.flatMap((category) => category.sections);

    expect(allSections).toContain('settings-appearance');
    expect(allSections).toContain('settings-layout');
    expect(allSections).toContain('settings-display');
    expect(allSections).toContain('settings-llm');
    expect(allSections).toContain('settings-command-policy');
    expect(allSections).toContain('settings-notification');
    expect(allSections).toContain('settings-experimental');
    expect(allSections).toContain('settings-mcp-server');
    expect(allSections).toContain('settings-transfer');
    expect(allSections).toContain('settings-about');
  });

  it('labels known categories and falls back for unknown category ids', () => {
    expect(getSettingsCategoryLabel('transfer')).toBe('文件传输');
    expect(getSettingsCategoryLabel('model')).toBe('模型');
    expect(getSettingsCategoryLabel('missing')).toBe('设置');
  });
});
