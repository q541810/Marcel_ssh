import type { OrphanConversationGroup } from './types';

/**
 * 「已删除的服务器」分组怎么给人看：桌面历史页、手机历史页、搜索结果标签共用这一处。
 *
 * - 删除时记下了名字：显示「名字（地址）」，隐私模式下不带地址；
 * - 更早以前就删掉的没有记录：显示「未知服务器」，靠最近一条对话的标题认人。
 */
export function orphanGroupTitle(group: OrphanConversationGroup, privacyMode: boolean): string {
  if (!group.name) return '未知服务器';
  return group.host && !privacyMode ? `${group.name} (${group.host})` : group.name;
}

/** 分组标题下面的小字：认不出服务器时给最近对话标题，否则给删除时间。 */
export function orphanGroupHint(group: OrphanConversationGroup): string {
  if (!group.name) {
    return group.lastTitle ? `最近对话：${group.lastTitle}` : '';
  }
  return group.deletedAt ? `删除于 ${new Date(group.deletedAt).toLocaleDateString()}` : '';
}

/** 搜索结果分组上的标签：同一个服务器名可能有已删除和现存两份，加前缀区分。 */
export function orphanSearchLabel(group: OrphanConversationGroup, privacyMode: boolean): string {
  return `已删除 · ${orphanGroupTitle(group, privacyMode)}`;
}

/**
 * 归档保留天数 → 说明文案。已删除服务器的对话与归档会话共用这个天数。
 * 0 = 永不自动清理。
 */
export function orphanRetentionNote(retentionDays: number): string {
  return retentionDays > 0
    ? `对话保留 ${retentionDays} 天后自动清理，可在设置里调整归档保留天数`
    : '对话不会自动清理（归档保留天数设为 0）';
}
