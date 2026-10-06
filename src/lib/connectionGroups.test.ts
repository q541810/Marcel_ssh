// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  COLLAPSED_GROUPS_STORAGE_KEY,
  loadCollapsedGroups,
  removeCollapsedGroup,
  saveCollapsedGroups,
  toggledCollapsedGroups,
} from '@/lib/connectionGroups';

afterEach(() => {
  localStorage.clear();
});

describe('loadCollapsedGroups / saveCollapsedGroups', () => {
  it('空存储返回空集', () => {
    expect(loadCollapsedGroups()).toEqual(new Set());
  });

  it('save → load 往返一致（双端共用同一份 localStorage）', () => {
    saveCollapsedGroups(new Set(['prod', 'test']));
    expect(loadCollapsedGroups()).toEqual(new Set(['prod', 'test']));
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual([
      'prod',
      'test',
    ]);
  });

  it('存储损坏（非数组 / 坏 JSON）时降级为空集，不抛错', () => {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, 'not json');
    expect(loadCollapsedGroups()).toEqual(new Set());
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, '5');
    expect(loadCollapsedGroups()).toEqual(new Set());
  });
});

describe('toggledCollapsedGroups / removeCollapsedGroup（纯函数）', () => {
  it('toggle 翻转成员且不改原集合', () => {
    const prev = new Set(['a']);
    const next = toggledCollapsedGroups(prev, 'b');
    expect(next).toEqual(new Set(['a', 'b']));
    expect(toggledCollapsedGroups(next, 'a')).toEqual(new Set(['b']));
    expect(prev).toEqual(new Set(['a']));
  });

  it('重命名丢弃旧组名；按既有行为只动内存集合，不回写 localStorage', () => {
    const prev = new Set(['旧名', '其他']);
    const next = removeCollapsedGroup(prev, '旧名');
    expect(next).toEqual(new Set(['其他']));
    expect(prev.has('旧名')).toBe(true);
    expect(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)).toBeNull();
  });
});
