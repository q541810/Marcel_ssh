import { describe, expect, it } from 'vitest';
import {
  UNGROUPED_NAME,
  groupConnections,
  groupNameOf,
  moveConnection,
  moveGroup,
  shiftConnection,
  toOrderEntries,
} from '@/lib/connectionOrder';

interface Conn {
  id: string;
  group?: string;
}

const ids = (list: Conn[]) => list.map((c) => c.id);
const groupOf = (list: Conn[], id: string) => list.find((c) => c.id === id)?.group;

describe('groupNameOf / groupConnections', () => {
  it('空分组名归一化为未分组', () => {
    expect(groupNameOf({})).toBe(UNGROUPED_NAME);
    expect(groupNameOf({ group: '' })).toBe(UNGROUPED_NAME);
    expect(groupNameOf({ group: '   ' })).toBe(UNGROUPED_NAME);
    expect(groupNameOf({ group: 'prod' })).toBe('prod');
  });

  it('组顺序 = 首次出现，组内保持数组顺序', () => {
    const list: Conn[] = [
      { id: 'a', group: 'prod' },
      { id: 'b' },
      { id: 'c', group: 'prod' },
      { id: 'd', group: 'test' },
    ];
    expect(groupConnections(list).map((g) => [g.name, ids(g.items)])).toEqual([
      ['prod', ['a', 'c']],
      [UNGROUPED_NAME, ['b']],
      ['test', ['d']],
    ]);
  });
});

describe('moveConnection', () => {
  it('同组内重排（锚点之前）', () => {
    const list: Conn[] = [
      { id: 'a', group: 'prod' },
      { id: 'b', group: 'prod' },
      { id: 'c', group: 'prod' },
    ];
    expect(ids(moveConnection(list, { dragId: 'c', toGroup: 'prod', beforeId: 'a' }))).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('移到组末尾（beforeId 为 null）', () => {
    const list: Conn[] = [
      { id: 'a', group: 'prod' },
      { id: 'b' },
      { id: 'c', group: 'prod' },
    ];
    expect(ids(moveConnection(list, { dragId: 'a', toGroup: 'prod', beforeId: null }))).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('跨组拖拽即移入，并写上目标分组', () => {
    const list: Conn[] = [
      { id: 'a', group: 'prod' },
      { id: 'b', group: 'test' },
      { id: 'c', group: 'test' },
    ];
    const next = moveConnection(list, { dragId: 'a', toGroup: 'test', beforeId: 'c' });
    expect(ids(next)).toEqual(['b', 'a', 'c']);
    expect(groupOf(next, 'a')).toBe('test');
  });

  it('拖进「未分组」写回 undefined（落盘为缺省）', () => {
    const list: Conn[] = [
      { id: 'a', group: 'prod' },
      { id: 'b' },
    ];
    const next = moveConnection(list, { dragId: 'a', toGroup: UNGROUPED_NAME, beforeId: 'b' });
    expect(ids(next)).toEqual(['a', 'b']);
    expect(groupOf(next, 'a')).toBeUndefined();
  });

  it('锚点不存在（被搜索过滤/已删除）时退化为目标组末尾，不丢连接', () => {
    const list: Conn[] = [
      { id: 'a', group: 'prod' },
      { id: 'b', group: 'test' },
    ];
    const next = moveConnection(list, { dragId: 'a', toGroup: 'test', beforeId: 'ghost' });
    expect(ids(next)).toEqual(['b', 'a']);
    expect(next).toHaveLength(2);
  });

  it('被拖拽的 id 不在列表里时原样返回', () => {
    const list: Conn[] = [{ id: 'a' }];
    expect(moveConnection(list, { dragId: 'ghost', toGroup: UNGROUPED_NAME })).toBe(list);
  });

  /**
   * 回归：落点锚就是被拖的那一行自己。
   *
   * 桌面拖拽按"行的中线"算插入位，而几何快照里被拖行还在原位 —— 指针压在它**自己的
   * 上半部**（抓着行名随手推 4px 就够）时算出来的插入位就是它。锚点随即被 remaining
   * 滤掉、findIndex 返回 -1 → 落进"锚点不在 → 组末尾"的兜底，行被甩到组尾。
   */
  it('落点锚就是自己时原地不动', () => {
    const list: Conn[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moveConnection(list, { dragId: 'b', toGroup: UNGROUPED_NAME, beforeId: 'b' })).toBe(list);
  });

  /**
   * 回归：自己是分组的唯一成员时，"这一组的末尾"就是原地。
   *
   * 不特判的话 `targetItems` 为空 → 落到 `remaining.length`（数组末尾），而组顺序 =
   * 首次出现，于是**整个分组**跳到列表最后。
   */
  it('自己是分组唯一成员时原地不动（整组不会被甩到末尾）', () => {
    const list: Conn[] = [{ id: 'solo', group: 'solo' }, { id: 'y' }];
    // 两个可达落点：锚点是自己，与组末尾（beforeId=null）。
    expect(moveConnection(list, { dragId: 'solo', toGroup: 'solo', beforeId: 'solo' })).toBe(list);
    expect(moveConnection(list, { dragId: 'solo', toGroup: 'solo', beforeId: null })).toBe(list);
    expect(ids(moveConnection(list, { dragId: 'solo', toGroup: 'solo' }))).toEqual(['solo', 'y']);
  });
});

describe('moveGroup', () => {
  const list: Conn[] = [
    { id: 'a1', group: 'A' },
    { id: 'b1', group: 'B' },
    { id: 'a2', group: 'A' },
    { id: 'c1' },
  ];

  it('整块搬到另一组之前，组内相对顺序不变', () => {
    const next = moveGroup(list, { groupName: 'A', beforeGroupName: UNGROUPED_NAME });
    // A 挪到「未分组」之前 → B、A、未分组，且数组变成按组连续
    expect(groupConnections(next).map((g) => g.name)).toEqual(['B', 'A', UNGROUPED_NAME]);
    expect(ids(next)).toEqual(['b1', 'a1', 'a2', 'c1']);
  });

  it('beforeGroupName 为 null 时挪到最后', () => {
    const next = moveGroup(list, { groupName: 'A', beforeGroupName: null });
    expect(groupConnections(next).map((g) => g.name)).toEqual(['B', UNGROUPED_NAME, 'A']);
    expect(ids(next)).toEqual(['b1', 'c1', 'a1', 'a2']);
  });

  it('组顺序没变化时返回同一个数组引用（避免无谓落库与数组重写）', () => {
    // 请求的位置与当前位置一致：B 本来就在「未分组」之前
    const next = moveGroup(list, { groupName: 'B', beforeGroupName: UNGROUPED_NAME });
    expect(next).toBe(list);
  });

  it('组名不存在时原样返回', () => {
    expect(moveGroup(list, { groupName: 'ghost', beforeGroupName: null })).toBe(list);
  });
});

describe('shiftConnection', () => {
  const list: Conn[] = [
    { id: 'a', group: 'prod' },
    { id: 'b', group: 'prod' },
    { id: 'c' },
  ];

  it('组内上移/下移只在同组邻居之间换位', () => {
    expect(ids(shiftConnection(list, { id: 'b', delta: -1 }))).toEqual(['b', 'a', 'c']);
    expect(ids(shiftConnection(list, { id: 'a', delta: 1 }))).toEqual(['b', 'a', 'c']);
  });

  it('到边界时原样返回，不会跨组跑', () => {
    expect(shiftConnection(list, { id: 'a', delta: -1 })).toBe(list);
    expect(shiftConnection(list, { id: 'b', delta: 1 })).toBe(list);
    expect(shiftConnection(list, { id: 'c', delta: 1 })).toBe(list);
  });
});

describe('toOrderEntries', () => {
  it('未分组发 null，其余原样带分组名', () => {
    expect(
      toOrderEntries([
        { id: 'a', group: 'prod' },
        { id: 'b' },
        { id: 'c', group: '  ' },
      ]),
    ).toEqual([
      { id: 'a', group: 'prod' },
      { id: 'b', group: null },
      { id: 'c', group: null },
    ]);
  });
});
