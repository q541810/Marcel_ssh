import { describe, expect, it } from 'vitest';
import type { OrphanConversationGroup } from './types';
import {
  orphanGroupHint,
  orphanGroupTitle,
  orphanRetentionNote,
  orphanSearchLabel,
} from './orphanConversations';

const known: OrphanConversationGroup = {
  connectionId: 'c1',
  name: 'web-01',
  host: '10.0.0.1',
  deletedAt: '2026-11-01T08:00:00Z',
  conversationCount: 3,
  lastUpdatedAt: '2026-10-30T08:00:00Z',
  lastTitle: '排查磁盘',
};
const unknown: OrphanConversationGroup = { ...known, name: null, host: null, deletedAt: null };

describe('orphanConversations', () => {
  it('带名字时显示名字和地址，隐私模式只显示名字', () => {
    expect(orphanGroupTitle(known, false)).toBe('web-01 (10.0.0.1)');
    expect(orphanGroupTitle(known, true)).toBe('web-01');
  });

  it('没有记录的服务器显示「未知服务器」，用最近对话认人', () => {
    expect(orphanGroupTitle(unknown, false)).toBe('未知服务器');
    expect(orphanGroupHint(unknown)).toBe('最近对话：排查磁盘');
    expect(orphanGroupHint({ ...unknown, lastTitle: '' })).toBe('');
  });

  it('有名字时小字是删除日期', () => {
    expect(orphanGroupHint(known)).toMatch(/^删除于 /);
  });

  it('搜索结果标签带「已删除」前缀', () => {
    expect(orphanSearchLabel(known, true)).toBe('已删除 · web-01');
  });

  it('保留天数说明：0 = 不自动清理', () => {
    expect(orphanRetentionNote(30)).toContain('30 天');
    expect(orphanRetentionNote(0)).toContain('不会自动清理');
  });
});
