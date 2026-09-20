import type { ConnectionOrderEntry } from '@/lib/tauri';

/**
 * 连接列表的分组与拖拽排序（纯函数，桌面与移动端共用）。
 *
 * 数据模型：`connections.json` 的**数组顺序就是展示顺序**，分组顺序 = 组在数组里
 * 首次出现的位置，组内顺序 = 该组成员在数组里的先后。所以三种拖拽（组内重排、
 * 跨组拖拽即移入、拖动整个分组）最终都收敛为「一份新的数组」→ 一次全量顺序写入
 * （后端 `config_apply_connection_order`）。刻意不引入 position 字段：数组顺序对
 * 旧版本客户端也是安全的（它们保存连接时不会把顺序抹掉），加字段反而会在降级时丢排序。
 *
 * 落点一律用**锚点**（id / 组名）而不是数字下标：搜索过滤时可见序列是完整序列的
 * 子集，数字下标在两者之间对不上，而锚点天然免疫。
 */

/** 没有分组的连接在界面上的归属名。空串/纯空白等同于未分组。 */
export const UNGROUPED_NAME = '未分组';

export interface ConnectionGroup<T> {
  name: string;
  items: T[];
}

/** 归一化分组名：空 → 未分组。 */
export function groupNameOf(conn: { group?: string | null }): string {
  return (conn.group ?? '').trim() || UNGROUPED_NAME;
}

/** 分组名 → 存进 `SavedConnection.group` 的值（未分组 = undefined，落盘为缺省）。 */
export function groupValueOf(name: string): string | undefined {
  return name === UNGROUPED_NAME ? undefined : name;
}

/** 按分组名把列表切成渲染用的分组（组顺序 = 首次出现；组内保持数组顺序）。 */
export function groupConnections<T extends { group?: string | null }>(
  list: T[],
): ConnectionGroup<T>[] {
  const groups: ConnectionGroup<T>[] = [];
  const byName = new Map<string, ConnectionGroup<T>>();
  for (const item of list) {
    const name = groupNameOf(item);
    let group = byName.get(name);
    if (!group) {
      group = { name, items: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * 把连接拖到某分组的某个位置（同组即重排，跨组即移入）。返回新的完整数组。
 *
 * `beforeId` = 插到该分组内的哪条连接之前；`null`/锚点已不在 = 放到该分组末尾
 * （锚点被过滤掉或已删除时退化为末尾，不会丢连接）。被拖拽的 id 不在列表里时原样返回。
 *
 * 两种"其实没动"必须显式原样返回，否则会退化成"扔到末尾"：
 *
 * - `beforeId === dragId` —— 落点锚就是被拖的那一行本身。指针压在被拖行**自己的
 *   上半部**时算出来的插入位就是它（几何快照含被拖行），而它已被 `remaining` 滤掉，
 *   `findIndex` 找不到 → 落进"锚点不在 → 组末尾"的兜底，把行甩到组尾。
 * - 目标组里除自己以外没有别人 —— 自己是这组的唯一成员。`targetItems` 为空时落到
 *   `remaining.length`，而组顺序 = 首次出现，于是**整个分组**跳到列表末尾。
 */
export function moveConnection<T extends { id: string; group?: string | null }>(
  list: T[],
  opts: { dragId: string; toGroup: string; beforeId?: string | null },
): T[] {
  const { dragId, toGroup, beforeId } = opts;
  const dragged = list.find((c) => c.id === dragId);
  if (!dragged) return list;
  if (beforeId === dragId) return list;

  const moved: T = { ...dragged, group: groupValueOf(toGroup) };
  const remaining = list.filter((c) => c.id !== dragId);
  const targetItems = remaining.filter((c) => groupNameOf(c) === toGroup);
  // 目标组是"自己这一组、且只有自己" → 组的末尾就是原地。
  if (targetItems.length === 0) return list;

  const anchorIndex = beforeId ? targetItems.findIndex((c) => c.id === beforeId) : -1;
  const at =
    anchorIndex >= 0
      ? remaining.indexOf(targetItems[anchorIndex])
      : remaining.indexOf(targetItems[targetItems.length - 1]) + 1;
  return [...remaining.slice(0, at), moved, ...remaining.slice(at)];
}

/**
 * 把某个分组整体挪到新位置（组内相对顺序不变）。返回新的完整数组。
 *
 * `beforeGroupName` = 挪到哪个分组之前；`null` = 挪到最后。
 * 结果会把数组重排成「按新组序连续排布」——顺带把历史遗留的跨组交错数组规范化，
 * 组顺序此后就是稳定的首次出现顺序。
 */
export function moveGroup<T extends { id: string; group?: string | null }>(
  list: T[],
  opts: { groupName: string; beforeGroupName?: string | null },
): T[] {
  const { groupName, beforeGroupName } = opts;
  const groups = groupConnections(list);
  const names = groups.map((g) => g.name);
  if (!names.includes(groupName)) return list;

  const without = names.filter((n) => n !== groupName);
  const anchor = beforeGroupName ? without.indexOf(beforeGroupName) : -1;
  const at = anchor >= 0 ? anchor : without.length;
  const nextNames = [...without.slice(0, at), groupName, ...without.slice(at)];
  if (nextNames.every((n, i) => n === names[i])) return list;

  const itemsByName = new Map(groups.map((g) => [g.name, g.items]));
  return nextNames.flatMap((name) => itemsByName.get(name) ?? []);
}

/** 组内上移/下移（右键菜单用）。到边界时原样返回。 */
export function shiftConnection<T extends { id: string; group?: string | null }>(
  list: T[],
  opts: { id: string; delta: -1 | 1 },
): T[] {
  const { id, delta } = opts;
  const target = list.find((c) => c.id === id);
  if (!target) return list;
  const groupName = groupNameOf(target);
  const siblings = list.filter((c) => groupNameOf(c) === groupName);
  const index = siblings.findIndex((c) => c.id === id);
  const toIndex = index + delta;
  if (toIndex < 0 || toIndex >= siblings.length) return list;
  // 下移要锚在「再下一个」之前（末尾则 null）；上移锚在当前前一个之前。
  const beforeId = delta === 1 ? (siblings[toIndex + 1]?.id ?? null) : siblings[toIndex].id;
  return moveConnection(list, { dragId: id, toGroup: groupName, beforeId });
}

/** 当前顺序（含分组）→ 后端要的落位表（未分组发 null）。 */
export function toOrderEntries(
  list: { id: string; group?: string | null }[],
): ConnectionOrderEntry[] {
  return list.map((c) => ({ id: c.id, group: groupValueOf(groupNameOf(c)) ?? null }));
}
