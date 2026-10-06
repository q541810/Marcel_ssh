import { describe, expect, it } from 'vitest';
import {
  canJumpToSession,
  getJobSessionLabel,
  getSessionLabel,
  type TaskCenterCatalog,
} from '@/lib/taskCenterLabels';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
import type { AgentConversation, AgentTask, SavedConnection, Session } from '@/lib/types';

// 数据形状参考 src/components/agent/AgentTasksDrawer.test.tsx 的 fixture 写法：
// 本机子任务/本机作业的契约是 `sessionId` 为哨兵值（用 toolCatalog 的常量，
// 不抄字面量）；真会话 id 是 UUID 形状的字符串。
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    connectionId: 'conn-1',
    status: 'connected',
    createdAt: TS,
    ...overrides,
  };
}

function connection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: 'conn-1',
    name: '生产机',
    host: '10.0.0.2',
    port: 22,
    username: 'deploy',
    authMethod: 'Password',
    ...overrides,
  };
}

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conv-1',
    connectionId: 'conn-1',
    title: '主对话',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function emptyCatalog(overrides: Partial<TaskCenterCatalog> = {}): TaskCenterCatalog {
  return {
    sessions: {},
    connections: [],
    conversations: {},
    tasks: {},
    ...overrides,
  };
}

describe('taskCenterLabels · getSessionLabel（Agent 任务卡片）', () => {
  it('本机子任务（sessionId 是哨兵值）标「本机」，不做反查', () => {
    // 哨兵优先于幽灵会话反查：即使对话归属能反查出连接，也不得说成「自动连接」。
    const catalog = emptyCatalog({
      conversations: { sub: conversation({ id: 'sub', connectionId: 'conn-1' }) },
      connections: [connection()],
    });
    expect(getSessionLabel(catalog, agentTask({ sessionId: LOCAL_SESSION_SENTINEL }))).toBe('本机');
  });

  it('会话在 store 里 → 按 configId 反查连接名', () => {
    const catalog = emptyCatalog({
      sessions: { 'session-1': session({ configId: 'conn-1' }) },
      connections: [connection()],
    });
    expect(getSessionLabel(catalog, agentTask())).toBe('生产机');
  });

  it('configId 反查不到连接 / 没有 configId → 回落 session.connectionId', () => {
    const catalog = emptyCatalog({
      sessions: { 'session-1': session({ configId: 'conn-gone' }) },
      connections: [connection({ id: 'conn-other', name: '别的机器' })],
    });
    expect(getSessionLabel(catalog, agentTask())).toBe('conn-1');

    const noConfig = emptyCatalog({
      sessions: { 'session-1': session() },
    });
    expect(getSessionLabel(noConfig, agentTask())).toBe('conn-1');
  });

  it('幽灵会话（不在 sessionStore）→ 经对话归属的 connectionId 反查，标「连接名（自动连接）」', () => {
    const catalog = emptyCatalog({
      connections: [connection()],
      conversations: { 'conv-1': conversation({ connectionId: 'conn-1' }) },
      tasks: { 'task-1': agentTask({ sessionId: 'session-ghost' }) },
    });
    expect(getSessionLabel(catalog, agentTask({ sessionId: 'session-ghost' }))).toBe(
      '生产机（自动连接）',
    );
  });

  it('幽灵会话反查不到连接 → 兜底「自动连接的目标机」', () => {
    // 有对话但连接已删除
    const withConv = emptyCatalog({
      conversations: { conv: conversation({ id: 'conv', connectionId: 'conn-gone' }) },
      tasks: { 'task-1': agentTask({ sessionId: 'session-ghost' }) },
    });
    expect(getSessionLabel(withConv, agentTask({ sessionId: 'session-ghost' }))).toBe(
      '自动连接的目标机',
    );

    // 连对话/任务痕迹都没有（旧数据）
    const bare = emptyCatalog();
    expect(getSessionLabel(bare, agentTask({ sessionId: 'session-ghost' }))).toBe(
      '自动连接的目标机',
    );
  });

  it('反查只认「该 sessionId 的任务所属的对话」，别的对话不算', () => {
    const catalog = emptyCatalog({
      connections: [connection()],
      conversations: { conv: conversation({ id: 'conv', connectionId: 'conn-1' }) },
      tasks: {
        // 任务挂在别的对话上，conversationId 对不上 → 反查不命中
        'task-1': agentTask({ sessionId: 'session-ghost', conversationId: 'conv-other' }),
      },
    });
    expect(getSessionLabel(catalog, agentTask({ sessionId: 'session-ghost' }))).toBe(
      '自动连接的目标机',
    );
  });
});

describe('taskCenterLabels · getJobSessionLabel（后台作业卡片）', () => {
  it('本机作业（sessionId 是哨兵值）标「本机」，不说「会话已关闭」', () => {
    expect(getJobSessionLabel(emptyCatalog(), LOCAL_SESSION_SENTINEL)).toBe('本机');
  });

  it('远端作业的会话已关闭 → 照实提示「会话已关闭」', () => {
    expect(getJobSessionLabel(emptyCatalog(), 'session-gone')).toBe(
      'session-gone（该任务对应会话已关闭）',
    );
  });

  it('会话在 store 里 → 显示连接名', () => {
    const catalog = emptyCatalog({
      sessions: { 'session-1': session({ configId: 'conn-1' }) },
      connections: [connection()],
    });
    expect(getJobSessionLabel(catalog, 'session-1')).toBe('生产机');
  });
});

describe('taskCenterLabels · canJumpToSession（点击卡片的跳转守卫）', () => {
  it('会话在 store、且不是当前会话 → 允许切换', () => {
    const sessions = { 'session-2': session({ id: 'session-2' }) };
    expect(canJumpToSession(sessions, agentTask({ sessionId: 'session-2' }), 'session-1')).toBe(
      true,
    );
  });

  it('本机子任务（哨兵 sessionId）不切 —— 没有终端标签可切', () => {
    expect(
      canJumpToSession({}, agentTask({ sessionId: LOCAL_SESSION_SENTINEL }), 'session-1'),
    ).toBe(false);
  });

  it('幽灵会话（不在 sessionStore）不切 —— setActiveSession 会指向不存在的 id', () => {
    expect(canJumpToSession({}, agentTask({ sessionId: 'session-ghost' }), 'session-1')).toBe(
      false,
    );
  });

  it('已经是当前会话不切；sessionId 为空不切', () => {
    const sessions = { 'session-1': session() };
    expect(canJumpToSession(sessions, agentTask(), 'session-1')).toBe(false);
    expect(canJumpToSession(sessions, agentTask({ sessionId: '' }), 'session-1')).toBe(false);
  });
});
