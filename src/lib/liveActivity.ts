/**
 * liveActivity.ts —— 「实时活动 / 灵动岛」要显示什么：Agent 任务表 → 一条胶囊内容。
 *
 * 纯函数，不 import 任何 store（调用方把任务表和对话标题递进来），所以桌面不用关心、
 * 移动端同步层（`mobile/liveActivitySync.ts`）和测试都能直接用。
 *
 * 只表达两件事，其余（完成 / 失败）已有 Agent 事件通知负责，不在岛上重复：
 * - 有任务卡在审批 / 提问上 → 「待确认」（用户得回来点一下，最需要被看见）
 * - 否则有任务在跑 → 「运行中」，带计时
 *
 * 状态判定复用 `lib/agentStatus` 的谓词，Agent 状态位增减时这里不会静默漏掉。
 */

import type { AgentTask } from '@/lib/types';
import { isTaskActive } from '@/lib/agentStatus';

export type LiveActivityKind = 'running' | 'waiting';

export interface LiveActivityContent {
  kind: LiveActivityKind;
  /** 胶囊 / 小岛里的短词（≤ 4 个字）。 */
  chip: string;
  /** 通知标题：对话标题；没有标题时用 App 名。 */
  title: string;
  /** 通知正文一行。 */
  text: string;
  /** 计时起点（epoch 毫秒）；等待态不计时，为 null。 */
  since: number | null;
}

const APP_NAME = 'Marcel SSH';

/** 对话标题还没生成时的占位（与 conversationStore 新建会话的默认标题一致）。 */
const DEFAULT_TITLE = '新会话';

function titleOf(
  task: AgentTask,
  titles: Readonly<Record<string, string | undefined>>,
): string {
  const raw = titles[task.conversationId]?.trim();
  if (!raw || raw === DEFAULT_TITLE) return APP_NAME;
  return raw;
}

function startedAt(task: AgentTask): number | null {
  const ms = Date.parse(task.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param tasks 全部任务（taskStore.tasks）
 * @param titles 对话 id → 标题
 * @returns 要显示的内容；没有任务在忙时返回 null（调用方据此撤掉岛）
 */
export function liveActivityOf(
  tasks: Readonly<Record<string, AgentTask>>,
  titles: Readonly<Record<string, string | undefined>>,
): LiveActivityContent | null {
  // 与任务中心 / 更新药丸同口径：sessionId 为空的是重启恢复的占位 task，不算真任务。
  const live = Object.values(tasks).filter((t) => !!t.sessionId);

  const waiting = live.filter((t) => t.status === 'waiting_approval');
  if (waiting.length > 0) {
    const first = waiting[0];
    return {
      kind: 'waiting',
      chip: '待确认',
      title: titleOf(first, titles),
      text:
        waiting.length > 1 ? `${waiting.length} 个任务等你确认` : '等你确认',
      since: null,
    };
  }

  const running = live.filter((t) => isTaskActive(t.status));
  if (running.length === 0) return null;

  // 计时从最早开始的那个任务算起；标题取它，跟计时指向同一件事。
  const sorted = [...running].sort(
    (a, b) => (startedAt(a) ?? Infinity) - (startedAt(b) ?? Infinity),
  );
  const first = sorted[0];
  return {
    kind: 'running',
    chip: '运行中',
    title: titleOf(first, titles),
    text:
      running.length > 1
        ? `正在干活 · ${running.length} 个任务在跑`
        : '正在干活',
    since: startedAt(first),
  };
}

/** 两条内容是否显示得一样（同步层据此跳过重复推送）。 */
export function sameLiveActivity(
  a: LiveActivityContent | null,
  b: LiveActivityContent | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.chip === b.chip &&
    a.title === b.title &&
    a.text === b.text &&
    a.since === b.since
  );
}
