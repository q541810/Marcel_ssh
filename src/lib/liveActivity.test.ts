import { describe, expect, it } from 'vitest';
import type { AgentStatus, AgentTask } from '@/lib/types';
import { liveActivityOf, sameLiveActivity } from './liveActivity';

function task(
  id: string,
  status: AgentStatus,
  over: Partial<AgentTask> = {},
): AgentTask {
  return {
    id,
    sessionId: 's1',
    conversationId: `c-${id}`,
    prompt: 'p',
    mode: 'agent',
    status,
    createdAt: '2026-11-06T10:00:00.000Z',
    ...over,
  };
}

const table = (...ts: AgentTask[]) =>
  Object.fromEntries(ts.map((t) => [t.id, t]));

describe('liveActivityOf', () => {
  it('没有任务时返回 null', () => {
    expect(liveActivityOf({}, {})).toBeNull();
  });

  it('只有终态任务时返回 null', () => {
    const tasks = table(
      task('a', 'completed'),
      task('b', 'failed'),
      task('c', 'cancelled'),
    );
    expect(liveActivityOf(tasks, {})).toBeNull();
  });

  it('运行中：带计时起点和对话标题', () => {
    const r = liveActivityOf(table(task('a', 'executing')), {
      'c-a': '排查磁盘',
    });
    expect(r).toEqual({
      kind: 'running',
      chip: '运行中',
      title: '排查磁盘',
      text: '正在干活',
      since: Date.parse('2026-11-06T10:00:00.000Z'),
    });
  });

  it('没有标题或还是默认标题时用 App 名', () => {
    expect(liveActivityOf(table(task('a', 'planning')), {})?.title).toBe(
      'Marcel SSH',
    );
    expect(
      liveActivityOf(table(task('a', 'planning')), { 'c-a': '新会话' })?.title,
    ).toBe('Marcel SSH');
    expect(
      liveActivityOf(table(task('a', 'planning')), { 'c-a': '  ' })?.title,
    ).toBe('Marcel SSH');
  });

  it('多个任务在跑：计时和标题取最早开始的那个，正文带个数', () => {
    const tasks = table(
      task('late', 'executing', { createdAt: '2026-11-06T10:05:00.000Z' }),
      task('early', 'planning', { createdAt: '2026-11-06T10:01:00.000Z' }),
    );
    const r = liveActivityOf(tasks, { 'c-early': 'A', 'c-late': 'B' });
    expect(r?.title).toBe('A');
    expect(r?.since).toBe(Date.parse('2026-11-06T10:01:00.000Z'));
    expect(r?.text).toBe('正在干活 · 2 个任务在跑');
  });

  it('待确认优先于运行中，且不计时', () => {
    const tasks = table(task('a', 'executing'), task('b', 'waiting_approval'));
    const r = liveActivityOf(tasks, { 'c-b': '部署' });
    expect(r).toEqual({
      kind: 'waiting',
      chip: '待确认',
      title: '部署',
      text: '等你确认',
      since: null,
    });
  });

  it('多个任务待确认：正文带个数', () => {
    const tasks = table(
      task('a', 'waiting_approval'),
      task('b', 'waiting_approval'),
    );
    expect(liveActivityOf(tasks, {})?.text).toBe('2 个任务等你确认');
  });

  it('子 agent 停在 ask_parent 上不亮岛', () => {
    expect(liveActivityOf(table(task('a', 'awaiting_parent')), {})).toBeNull();
  });

  it('sessionId 为空的重启占位 task 不算', () => {
    expect(
      liveActivityOf(table(task('a', 'executing', { sessionId: '' })), {}),
    ).toBeNull();
  });

  it('createdAt 解析不了时不计时但仍显示', () => {
    const r = liveActivityOf(
      table(task('a', 'executing', { createdAt: 'oops' })),
      {},
    );
    expect(r?.kind).toBe('running');
    expect(r?.since).toBeNull();
  });
});

describe('sameLiveActivity', () => {
  const base = liveActivityOf(table(task('a', 'executing')), {});
  it('同内容为真，null 与内容为假，null 与 null 为真', () => {
    expect(
      sameLiveActivity(base, liveActivityOf(table(task('a', 'executing')), {})),
    ).toBe(true);
    expect(sameLiveActivity(base, null)).toBe(false);
    expect(sameLiveActivity(null, null)).toBe(true);
  });
  it('任一显示字段变了为假', () => {
    const other = liveActivityOf(table(task('a', 'waiting_approval')), {});
    expect(sameLiveActivity(base, other)).toBe(false);
  });
});
