import { describe, expect, it, vi } from 'vitest';
import {
  canOpenCommandMenu,
  compactingSelectorOf,
  deriveSubAgentDispatch,
} from '@/lib/agentPanelDerived';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
import type { AgentTask } from '@/lib/types';

const TS = '2026-09-28T10:00:00.000Z';

function agentTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    conversationId: 'conv-1',
    prompt: '看一下构建脚本',
    mode: 'plan',
    status: 'executing',
    createdAt: TS,
    ...overrides,
  };
}

describe('agentPanelDerived · deriveSubAgentDispatch（子 agent 派生）', () => {
  it('无 activeConversationId → { plan, isLocal: false }（即使任务表里有子任务）', () => {
    const tasks = {
      'sub-1': agentTask({
        id: 'sub-1',
        sessionId: LOCAL_SESSION_SENTINEL,
        parentTaskId: 'parent',
        mode: 'agent',
      }),
    };
    expect(deriveSubAgentDispatch(tasks, null)).toEqual({ mode: 'plan', isLocal: false });
    expect(deriveSubAgentDispatch(tasks, undefined)).toEqual({ mode: 'plan', isLocal: false });
  });

  it('当前对话没有子任务（只有主任务）→ { plan, isLocal: false }', () => {
    // 主任务不带 parentTaskId，不能把输入区误判成子 agent 派发。
    const tasks = { 'main-1': agentTask({ id: 'main-1', mode: 'agent' }) };
    expect(deriveSubAgentDispatch(tasks, 'conv-1')).toEqual({ mode: 'plan', isLocal: false });
  });

  it('agent 模式的子任务 → mode: agent；sessionId 是哨兵 → isLocal: true', () => {
    const tasks = {
      'sub-1': agentTask({
        id: 'sub-1',
        sessionId: LOCAL_SESSION_SENTINEL,
        parentTaskId: 'parent',
        mode: 'agent',
      }),
    };
    expect(deriveSubAgentDispatch(tasks, 'conv-1')).toEqual({ mode: 'agent', isLocal: true });
  });

  it('plan 模式 / 远端子任务 → { plan, isLocal: false }', () => {
    const tasks = {
      'sub-remote': agentTask({
        id: 'sub-remote',
        sessionId: '11111111-2222-4333-8444-555555555555',
        parentTaskId: 'parent',
        mode: 'plan',
      }),
    };
    expect(deriveSubAgentDispatch(tasks, 'conv-1')).toEqual({ mode: 'plan', isLocal: false });
  });

  it('只认属于当前对话的任务', () => {
    const tasks = {
      'sub-other': agentTask({
        id: 'sub-other',
        conversationId: 'conv-other',
        parentTaskId: 'parent',
        mode: 'agent',
      }),
    };
    expect(deriveSubAgentDispatch(tasks, 'conv-1')).toEqual({ mode: 'plan', isLocal: false });
  });

  it('auto 模式的子任务按 plan 呈现（mode 只区分 agent / 非 agent）', () => {
    const tasks = {
      'sub-auto': agentTask({
        id: 'sub-auto',
        parentTaskId: 'parent',
        mode: 'auto',
      }),
    };
    expect(deriveSubAgentDispatch(tasks, 'conv-1')).toEqual({ mode: 'plan', isLocal: false });
  });
});

describe('agentPanelDerived · compactingSelectorOf（压缩订阅 selector）', () => {
  it('当前对话在压缩 → true；不在压缩 → false', () => {
    const selecting = compactingSelectorOf('conv-1');
    expect(selecting({ compacting: { 'conv-1': true } })).toBe(true);
    expect(selecting({ compacting: {} })).toBe(false);
    // 压缩的是别的会话
    expect(selecting({ compacting: { 'conv-other': true } })).toBe(false);
  });

  it('无 activeConversationId → 恒 false（即使表里有别的会话在压缩）', () => {
    const selecting = compactingSelectorOf(null);
    expect(selecting({ compacting: { 'conv-other': true } })).toBe(false);
  });
});

describe('agentPanelDerived · canOpenCommandMenu（`/` 菜单门控）', () => {
  it('输入不是命令草稿 → 恒不唤出（不算 busy）', () => {
    const isBusy = vi.fn(() => false);
    expect(canOpenCommandMenu(false, 'conv-1', isBusy)).toBe(false);
    expect(isBusy).not.toHaveBeenCalled();
  });

  it('没有进行中的对话 → 唤出', () => {
    const isBusy = vi.fn(() => false);
    expect(canOpenCommandMenu(true, null, isBusy)).toBe(true);
    expect(isBusy).not.toHaveBeenCalled();
  });

  it('对话空闲 → 唤出；任务运行中 / 压缩中（conversationIsBusy）→ 不唤出', () => {
    expect(canOpenCommandMenu(true, 'conv-1', () => false)).toBe(true);
    expect(canOpenCommandMenu(true, 'conv-1', () => true)).toBe(false);
  });
});
