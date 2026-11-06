import { describe, expect, it } from 'vitest';
import {
  conversationActivity,
  initialMood,
  latestOutcome,
  MASCOT_TIMING as T,
  mascotForEmptyState,
  stepMood,
  wakeMood,
  type MascotActivity,
  type MoodState,
} from './mood';
import type { AgentStatus } from '@/lib/types';

const fam = new Set(['c1', 'c1-sub']);

describe('conversationActivity', () => {
  it('前台交互属于本对话（含子对话）时，按种类分审批 / 提问', () => {
    const tasks = [{ status: 'waiting_approval' as AgentStatus, conversationId: 'c1' }];
    expect(conversationActivity(tasks, fam, { kind: 'approval', conversationId: 'c1' })).toBe('approval');
    expect(conversationActivity(tasks, fam, { kind: 'question', conversationId: 'c1-sub' })).toBe('asking');
  });

  it('交互属于别的对话时不算本对话的；本对话自己有 waiting_approval 仍算审批', () => {
    const tasks = [{ status: 'executing' as AgentStatus, conversationId: 'c1' }];
    expect(conversationActivity(tasks, fam, { kind: 'approval', conversationId: 'other' })).toBe('running');
    expect(conversationActivity([{ status: 'waiting_approval', conversationId: 'c1' }], fam, null)).toBe('approval');
  });

  it('executing = 执行，planning = 思考，都没有 = 闲着；停在提问上的子 agent 不算忙', () => {
    expect(conversationActivity([{ status: 'planning', conversationId: 'c1' }], fam, null)).toBe('thinking');
    expect(conversationActivity([
      { status: 'planning', conversationId: 'c1' },
      { status: 'executing', conversationId: 'c1-sub' },
    ], fam, null)).toBe('running');
    expect(conversationActivity([{ status: 'awaiting_parent', conversationId: 'c1-sub' }], fam, null)).toBe('idle');
    expect(conversationActivity([{ status: 'completed', conversationId: 'c1' }], fam, null)).toBe('idle');
  });
});

describe('latestOutcome', () => {
  it('取本对话最近一个主任务的状态，子 agent 任务不算', () => {
    const tasks = [
      { status: 'failed' as AgentStatus, conversationId: 'c1', createdAt: '2026-01-01T00:00:00Z' },
      { status: 'completed' as AgentStatus, conversationId: 'c1', createdAt: '2026-01-02T00:00:00Z' },
      { status: 'failed' as AgentStatus, conversationId: 'c1', createdAt: '2026-01-03T00:00:00Z', parentTaskId: 'x' },
      { status: 'failed' as AgentStatus, conversationId: 'c2', createdAt: '2026-01-04T00:00:00Z' },
    ];
    expect(latestOutcome(tasks, 'c1')).toBe('completed');
    expect(latestOutcome(tasks, 'none')).toBeNull();
  });
});

/** 按时间顺序喂一串输入，返回每一步显示的动作。 */
function run(start: MoodState, inputs: [number, MascotActivity, AgentStatus | null][]) {
  let st = start;
  return inputs.map(([now, activity, outcome]) => {
    const step = stepMood(st, { activity, outcome, now });
    st = step.state;
    return { shown: st.shown, wakeAt: step.wakeAt };
  });
}

describe('stepMood（导演）', () => {
  it('轮与轮之间短暂「不忙」不会闪回闲着', () => {
    const out = run(initialMood('idle', 0), [
      [1000, 'running', null],
      [2000, 'idle', 'executing'],        // 两轮之间的空档
      [2300, 'running', 'executing'],     // 不到 leaveBusyAfterMs 又忙起来
    ]);
    expect(out.map((o) => o.shown)).toEqual(['running', 'running', 'running']);
    expect(out[1].wakeAt).toBe(2000 + T.leaveBusyAfterMs);
  });

  it('真的停了且成功：播「完成」，播完回到闲着，再过一阵睡着', () => {
    const t0 = 5000;
    const out = run(initialMood('running', 0), [
      [t0, 'idle', 'completed'],
      [t0 + T.leaveBusyAfterMs, 'idle', 'completed'],
    ]);
    expect(out[0].shown).toBe('running');
    expect(out[1].shown).toBe('done');
    const doneUntil = t0 + T.leaveBusyAfterMs + T.doneMs;
    expect(out[1].wakeAt).toBe(doneUntil);

    let st = stepMood(initialMood('running', 0), { activity: 'idle', outcome: 'completed', now: t0 }).state;
    st = stepMood(st, { activity: 'idle', outcome: 'completed', now: t0 + T.leaveBusyAfterMs }).state;
    const back = stepMood(st, { activity: 'idle', outcome: 'completed', now: doneUntil });
    expect(back.state.shown).toBe('idle');
    expect(back.wakeAt).toBe(doneUntil + T.sleepAfterMs);
    expect(stepMood(back.state, { activity: 'idle', outcome: 'completed', now: doneUntil + T.sleepAfterMs }).state.shown)
      .toBe('sleeping');
  });

  it('失败播「失败」；手动停止（cancelled）直接回到闲着', () => {
    const settle = (outcome: AgentStatus) => {
      let st = stepMood(initialMood('running', 0), { activity: 'idle', outcome, now: 100 }).state;
      st = stepMood(st, { activity: 'idle', outcome, now: 100 + T.leaveBusyAfterMs }).state;
      return st.shown;
    };
    expect(settle('failed')).toBe('error');
    expect(settle('cancelled')).toBe('idle');
  });

  it('一开始就是做完的对话（切过来 / 刚挂载）不庆祝', () => {
    const st = stepMood(initialMood('idle', 0), { activity: 'idle', outcome: 'completed', now: 10 });
    expect(st.state.shown).toBe('idle');
  });

  it('审批 / 提问刚被处理的那一瞬显示「执行」，不继续举手', () => {
    const out = run(initialMood('idle', 0), [
      [0, 'approval', 'waiting_approval'],
      [50, 'idle', 'waiting_approval'],
    ]);
    expect(out.map((o) => o.shown)).toEqual(['approval', 'running']);
  });
});

describe('wakeMood', () => {
  it('睡着时戳一下醒来并重新计时；干活时戳不改状态（同一个对象）', () => {
    const asleep: MoodState = { ...initialMood('idle', 0), shown: 'sleeping' };
    const woke = wakeMood(asleep, 1000);
    expect(woke.state.shown).toBe('idle');
    expect(woke.wakeAt).toBe(1000 + T.sleepAfterMs);

    const busy = initialMood('running', 0);
    expect(wakeMood(busy, 1000).state).toBe(busy);
  });
});

describe('mascotForEmptyState', () => {
  it('空白页跟连接状态走', () => {
    expect(mascotForEmptyState('no-session')).toBe('sleeping');
    expect(mascotForEmptyState('connecting')).toBe('offline');
    expect(mascotForEmptyState('disconnected')).toBe('offline');
    expect(mascotForEmptyState('error')).toBe('error');
    expect(mascotForEmptyState('no-config')).toBe('error');
    expect(mascotForEmptyState('ready')).toBe('idle');
  });
});
