import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  getSettingsPage,
  groupSettingsPages,
  isSettingsPageId,
} from './settingsCatalog';
import { SETTINGS_CATEGORIES } from '@/components/settings/settingsNavigation';
import { MOBILE_SETTINGS_CATEGORIES } from '@/mobile/mobileSettingsModel';
import { MEMORY_SETTINGS_CATEGORY } from './memoryNav';
import { SYNC_SETTINGS_CATEGORY } from './syncNav';
import { RISK_RULES_DESKTOP_CATEGORY, RISK_RULES_MOBILE_CATEGORY } from './riskRuleNav';

describe('settingsCatalog', () => {
  it('页 id 不重复，且每页都属于一个已声明的组', () => {
    const ids = SETTINGS_PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.id));
    for (const page of SETTINGS_PAGES) expect(groups.has(page.group)).toBe(true);
  });

  it('桌面与手机用同一份目录：页 id、页名、顺序完全一致', () => {
    const desktop = SETTINGS_CATEGORIES.map((c) => [c.id, c.title]);
    const mobile = MOBILE_SETTINGS_CATEGORIES.map((c) => [c.id, c.title]);
    expect(desktop).toEqual(mobile);
    expect(desktop).toEqual(SETTINGS_PAGES.map((p) => [p.id, p.title]));
  });

  it('跳转用的页 id 都存在于目录里（记忆 / 同步 / 风险规则）', () => {
    for (const id of [
      MEMORY_SETTINGS_CATEGORY,
      SYNC_SETTINGS_CATEGORY,
      RISK_RULES_DESKTOP_CATEGORY,
      RISK_RULES_MOBILE_CATEGORY,
    ]) {
      expect(isSettingsPageId(id), `${id} 不在 settingsCatalog 里`).toBe(true);
    }
  });

  it('分组保持目录顺序，「关于」单独一组且无组标题', () => {
    const grouped = groupSettingsPages(SETTINGS_PAGES);
    expect(grouped.map((g) => g.group.id)).toEqual(['ai', 'app', 'about']);
    expect(grouped[2].group.title).toBeNull();
    expect(grouped[2].pages.map((p) => p.id)).toEqual(['about']);
    expect(grouped.flatMap((g) => g.pages.map((p) => p.id))).toEqual(
      SETTINGS_PAGES.map((p) => p.id),
    );
  });

  it('旧页名保留为别名，改名后按老名字仍能找到', () => {
    expect(getSettingsPage('tools')?.aliases).toContain('工具能力');
    expect(getSettingsPage('sync')?.aliases).toContain('会话与归档');
    expect(getSettingsPage('appearance')?.aliases).toContain('文件传输');
  });
});
