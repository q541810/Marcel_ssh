/**
 * 连接列表分组折叠状态的持久化（桌面 ConnectionList / 移动 MobileConnectionList
 * 共用，localStorage 是同一份——用户在两端看到的折叠状态一致）。
 *
 * key = 分组名。刻意独立于 `connectionOrder`：排序是**数据**（进 connections.json
 * 落库），折叠只是**视图状态**（只进 localStorage），两者生命周期不同，不混放。
 */

const STORAGE_KEY = 'marcel-collapsed-connection-groups';

/** 供测试 / 排查用：这份数据落在 localStorage 的哪个 key 下。 */
export const COLLAPSED_GROUPS_STORAGE_KEY = STORAGE_KEY;

/** 读初始折叠状态；localStorage 不可用 / 数据损坏时返回空集（不报错、不清盘）。 */
export function loadCollapsedGroups(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

/** 把整份折叠状态写回 localStorage；写失败不阻止切换（下次 toggle 再试）。 */
export function saveCollapsedGroups(groups: Iterable<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...groups]));
  } catch {
    // localStorage 失败不阻止切换
  }
}

/** toggle 的纯逻辑部分：返回翻转后的新集合（调用方负责随后 saveCollapsedGroups）。 */
export function toggledCollapsedGroups(
  prev: Set<string>,
  groupName: string,
): Set<string> {
  const next = new Set(prev);
  if (next.has(groupName)) {
    next.delete(groupName);
  } else {
    next.add(groupName);
  }
  return next;
}

/**
 * 分组重命名后丢弃旧名字的折叠状态。
 *
 * 与既有行为一致：**只动内存集合，不回写 localStorage**——旧 key 留到下一次
 * toggle 时被整体覆盖，无副作用（同名分组消失后它本来就是死数据）。
 */
export function removeCollapsedGroup(
  prev: Set<string>,
  groupName: string,
): Set<string> {
  const next = new Set(prev);
  next.delete(groupName);
  return next;
}
