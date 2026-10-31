// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pointInRect, resolveTreeDropTarget, treePathAtPoint } from './fileTreeDrop';

const rect = { left: 0, right: 200, top: 0, bottom: 400 };

function fakeHit(el: Element | null) {
  return () => el;
}

describe('目录树拖入落点判定', () => {
  it('按坐标找到带 data-tree-path 的行（点在行内的子元素上也算）', () => {
    const row = document.createElement('div');
    row.setAttribute('data-tree-path', '/var/log');
    const label = document.createElement('span');
    row.appendChild(label);
    expect(treePathAtPoint({ x: 5, y: 5 }, fakeHit(label))).toBe('/var/log');
  });

  it('没有指着任何行返回 null', () => {
    expect(treePathAtPoint({ x: 5, y: 5 }, fakeHit(document.createElement('div')))).toBeNull();
    expect(treePathAtPoint({ x: 5, y: 5 }, fakeHit(null))).toBeNull();
  });

  it('pointInRect 含边界', () => {
    expect(pointInRect({ x: 0, y: 400 }, rect)).toBe(true);
    expect(pointInRect({ x: 201, y: 10 }, rect)).toBe(false);
  });

  it('树区域外 → outside；树内空白 → blank；树内行 → row', () => {
    const row = document.createElement('div');
    row.setAttribute('data-tree-path', '/etc');
    const blank = document.createElement('div');

    expect(resolveTreeDropTarget({ x: 300, y: 10 }, rect, true, fakeHit(row))).toEqual({
      kind: 'outside',
    });
    expect(resolveTreeDropTarget({ x: 10, y: 10 }, rect, true, fakeHit(blank))).toEqual({
      kind: 'blank',
    });
    expect(resolveTreeDropTarget({ x: 10, y: 10 }, rect, true, fakeHit(row))).toEqual({
      kind: 'row',
      path: '/etc',
    });
  });

  it('树被隐藏或没有坐标时一律 outside（沿用当前目录）', () => {
    const row = document.createElement('div');
    row.setAttribute('data-tree-path', '/etc');
    expect(resolveTreeDropTarget({ x: 10, y: 10 }, rect, false, fakeHit(row)).kind).toBe('outside');
    expect(resolveTreeDropTarget(undefined, rect, true, fakeHit(row)).kind).toBe('outside');
    expect(resolveTreeDropTarget({ x: 10, y: 10 }, null, true, fakeHit(row)).kind).toBe('outside');
  });
});
