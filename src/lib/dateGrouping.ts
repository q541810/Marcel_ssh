import type { AgentConversation } from '@/lib/types';

export type TimeGroupKey = 'today' | 'yesterday' | 'within7Days' | 'within30Days' | 'earlier';

export interface TimeGroup<T = AgentConversation> {
  key: TimeGroupKey;
  label: string;
  items: T[];
}

export const TIME_GROUP_LABELS: Record<TimeGroupKey, string> = {
  today: '今天',
  yesterday: '昨天',
  within7Days: '七天之内',
  within30Days: '这个月之内',
  earlier: '更早之前',
};

/**
 * 将给定的会话或带 updatedAt 的项目按自然时间分组：
 * - 今天 (Today 00:00:00 至今)
 * - 昨天 (Yesterday 00:00:00 至 Today 00:00:00)
 * - 七天之内 (过去7天内，不含今天、昨天)
 * - 这个月之内 (过去30天内，不含7天内)
 * - 更早之前 (超过30天前或无效时间)
 */
export function groupConversationsByDate<T extends { updatedAt?: string; createdAt?: string }>(
  items: T[],
  now: Date = new Date(),
): TimeGroup<T>[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = startOfToday - 30 * 24 * 60 * 60 * 1000;

  const groups: Record<TimeGroupKey, T[]> = {
    today: [],
    yesterday: [],
    within7Days: [],
    within30Days: [],
    earlier: [],
  };

  // 先按更新时间从新到旧排序
  const sorted = [...items].sort((a, b) => {
    const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  for (const item of sorted) {
    const timeStr = item.updatedAt || item.createdAt;
    const time = timeStr ? new Date(timeStr).getTime() : NaN;

    if (isNaN(time)) {
      groups.earlier.push(item);
      continue;
    }

    if (time >= startOfToday) {
      groups.today.push(item);
    } else if (time >= startOfYesterday) {
      groups.yesterday.push(item);
    } else if (time >= sevenDaysAgo) {
      groups.within7Days.push(item);
    } else if (time >= thirtyDaysAgo) {
      groups.within30Days.push(item);
    } else {
      groups.earlier.push(item);
    }
  }

  const result: TimeGroup<T>[] = [];
  const keys: TimeGroupKey[] = ['today', 'yesterday', 'within7Days', 'within30Days', 'earlier'];

  for (const key of keys) {
    if (groups[key].length > 0) {
      result.push({
        key,
        label: TIME_GROUP_LABELS[key],
        items: groups[key],
      });
    }
  }

  return result;
}
