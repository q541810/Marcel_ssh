/**
 * 玛瑟尔此刻该做什么动作——纯函数部分（不读 store、不碰计时器，全部可单测）。
 *
 * 两层：
 * 1. `conversationActivity`：从任务表 + 当前交互，算出这个对话「正在发生什么」（瞬时值）。
 * 2. `stepMood`：导演。把瞬时值变成「给用户看的动作」，处理三件瞬时值做不到的事：
 *    - **防闪烁**：一轮工具调用和下一轮模型请求之间任务会有一瞬「不忙」，直接照搬会让玛瑟尔抽搐，
 *      所以忙 → 不忙要先等 `leaveBusyAfterMs` 确认真的停了；
 *    - **一次性的结局**：真的停下时看这轮是成功还是失败，播一段「完成」/「失败」再回到闲着；
 *      只在「忙 → 停」那一刻触发，切到一个早就做完的对话不会无缘无故庆祝；
 *    - **睡着**：闲着超过 `sleepAfterMs` 就睡，有任何动静（或被戳一下）就醒。
 *
 * 状态的分类口径一律复用 `lib/agentStatus`（`isTaskActive` / `isTaskBusy`），别在这里另写一串字面量。
 */
import type { AgentStatus, AgentTask, InteractionKind } from '@/lib/types';
import { isTaskActive } from '@/lib/agentStatus';
import type { MascotState } from './frames';

/** 对话此刻正在发生的事（瞬时值）。 */
export type MascotActivity = 'idle' | 'thinking' | 'running' | 'approval' | 'asking';

export interface MascotInteraction {
  kind: InteractionKind;
  conversationId: string;
}

/**
 * @param tasks 本对话及其子对话（子 agent）的任务
 * @param familyIds 本对话 id + 子对话 id
 * @param interaction 当前弹出的审批 / 提问（全局只有一个在前台）
 */
export function conversationActivity(
  tasks: readonly Pick<AgentTask, 'status' | 'conversationId'>[],
  familyIds: ReadonlySet<string>,
  interaction: MascotInteraction | null,
): MascotActivity {
  // 审批与提问都会把任务标成 waiting_approval；要分清是哪一种，只能看交互本身
  if (interaction && familyIds.has(interaction.conversationId)) {
    return interaction.kind === 'question' ? 'asking' : 'approval';
  }
  if (tasks.some((t) => t.status === 'waiting_approval')) return 'approval';
  // planning 只持续到模型吐出第一段正文（见 agentStreamHandlers.handleTextDelta）：
  // 这段时间就是「在想」；之后整轮都是 executing
  if (tasks.some((t) => t.status === 'executing')) return 'running';
  if (tasks.some((t) => isTaskActive(t.status))) return 'thinking';
  return 'idle';
}

/** 本对话最近一个主任务（不含子 agent）的最终状态：用来判断这轮是成功还是失败。 */
export function latestOutcome(
  tasks: readonly Pick<AgentTask, 'status' | 'conversationId' | 'createdAt' | 'parentTaskId'>[],
  conversationId: string,
): AgentStatus | null {
  let best: (typeof tasks)[number] | null = null;
  for (const t of tasks) {
    if (t.conversationId !== conversationId || t.parentTaskId) continue;
    if (!best || t.createdAt > best.createdAt) best = t;
  }
  return best?.status ?? null;
}

export const MASCOT_TIMING = {
  /** 忙 → 不忙要持续这么久才算真的停了（盖住轮与轮之间的空档）。 */
  leaveBusyAfterMs: 700,
  /** 「完成」播多久：完整一轮蹲、跳、炸爆米花约 2.6 秒，留一点余量。 */
  doneMs: 3200,
  /** 「失败」停留多久再回到闲着：让用户看清，但别一直哭丧着脸。 */
  errorMs: 8000,
  /** 闲着多久睡着。 */
  sleepAfterMs: 5 * 60_000,
} as const;

export interface MoodState {
  shown: MascotState;
  /** 上一次输入里的瞬时活动。 */
  activity: MascotActivity;
  /** 进入「疑似停了」的时刻；null = 没在等。 */
  stoppingSince: number | null;
  /** 「完成」/「失败」播到什么时候；0 = 没有。 */
  transientUntil: number;
  /** 从什么时候开始闲着（算睡觉用）。 */
  idleSince: number;
}

export function initialMood(activity: MascotActivity, now: number): MoodState {
  return {
    shown: activity === 'idle' ? 'idle' : activity,
    activity,
    stoppingSince: null,
    transientUntil: 0,
    idleSince: now,
  };
}

export interface MoodStep {
  state: MoodState;
  /** 下次需要重新算的时刻（到点了状态会自己变）；null = 不用定时。 */
  wakeAt: number | null;
}

/**
 * 导演：给定上一刻的状态与此刻的输入，算出要显示的动作。
 * 纯函数——计时器由调用方按 `wakeAt` 安排，到点再调一次。
 */
export function stepMood(
  prev: MoodState,
  input: { activity: MascotActivity; outcome: AgentStatus | null; now: number },
): MoodStep {
  const { activity, outcome, now } = input;
  const T = MASCOT_TIMING;

  if (activity !== 'idle') {
    return {
      state: { shown: activity, activity, stoppingSince: null, transientUntil: 0, idleSince: now },
      wakeAt: null,
    };
  }

  const wasBusy = prev.activity !== 'idle' || prev.stoppingSince !== null;
  if (wasBusy) {
    const since = prev.stoppingSince ?? now;
    if (now - since < T.leaveBusyAfterMs) {
      // 还没确认停：保持「在干活」的样子。停在审批 / 提问上刚被处理时，任务马上会回到执行，
      // 这一瞬显示「执行命令」比继续举手更贴近事实
      const holding: MascotState = prev.shown === 'thinking' ? 'thinking' : 'running';
      return {
        state: { ...prev, shown: holding, activity, stoppingSince: since },
        wakeAt: since + T.leaveBusyAfterMs,
      };
    }
    // 确认停了：看结局
    if (outcome === 'completed' || outcome === 'failed') {
      const done = outcome === 'completed';
      const until = now + (done ? T.doneMs : T.errorMs);
      return {
        state: { shown: done ? 'done' : 'error', activity, stoppingSince: null, transientUntil: until, idleSince: until },
        wakeAt: until,
      };
    }
    return {
      state: { shown: 'idle', activity, stoppingSince: null, transientUntil: 0, idleSince: now },
      wakeAt: now + T.sleepAfterMs,
    };
  }

  if (prev.transientUntil > now) {
    return { state: { ...prev, activity }, wakeAt: prev.transientUntil };
  }
  const sleepAt = prev.idleSince + T.sleepAfterMs;
  if (now >= sleepAt) {
    return { state: { ...prev, shown: 'sleeping', activity, transientUntil: 0 }, wakeAt: null };
  }
  return { state: { ...prev, shown: 'idle', activity, transientUntil: 0 }, wakeAt: sleepAt };
}

/** 被戳一下：睡着的醒过来，闲着的重新计时；正在干活 / 正在播结局的不受影响。 */
export function wakeMood(prev: MoodState, now: number): MoodStep {
  if (prev.activity !== 'idle' || prev.stoppingSince !== null || prev.transientUntil > now) {
    return { state: prev, wakeAt: null };
  }
  return {
    state: { ...prev, shown: 'idle', idleSince: now, transientUntil: 0 },
    wakeAt: now + MASCOT_TIMING.sleepAfterMs,
  };
}

/** 空白页（还没有消息 / 用不了助手）时的动作：跟连接状态走。 */
export type MascotEmptyReason = 'no-session' | 'connecting' | 'disconnected' | 'error' | 'no-config' | 'ready';

export function mascotForEmptyState(reason: MascotEmptyReason): MascotState {
  switch (reason) {
    case 'no-session':
      return 'sleeping';      // 还没连任何机器：没活干，睡着等你
    case 'connecting':
    case 'disconnected':
      return 'offline';       // 耳朵当天线找信号
    case 'error':
    case 'no-config':
      return 'error';         // 连不上 / 用不了：爆米花撒了
    case 'ready':
      return 'idle';
  }
}
