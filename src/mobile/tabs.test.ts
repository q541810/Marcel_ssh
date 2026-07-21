import { describe, it, expect } from 'vitest';
import { DEFAULT_MOBILE_TAB, MOBILE_TABS, isMobileTab } from './tabs';

describe('mobile tabs', () => {
  it('defaults to terminal tab', () => {
    expect(DEFAULT_MOBILE_TAB).toBe('terminal');
  });

  it('exposes four primary tabs in order', () => {
    expect(MOBILE_TABS.map((t) => t.id)).toEqual([
      'terminal',
      'agent',
      'files',
      'settings',
    ]);
  });

  it('labels are Chinese', () => {
    expect(MOBILE_TABS.map((t) => t.label)).toEqual([
      '终端',
      'Agent',
      '文件',
      '设置',
    ]);
  });

  it('isMobileTab validates known ids only', () => {
    expect(isMobileTab('terminal')).toBe(true);
    expect(isMobileTab('agent')).toBe(true);
    expect(isMobileTab('files')).toBe(true);
    expect(isMobileTab('settings')).toBe(true);
    expect(isMobileTab('plugins')).toBe(false);
    expect(isMobileTab('unknown')).toBe(false);
  });
});
