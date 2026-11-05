// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useJobStore } from '@/stores/jobStore';
import { useSettingsStore } from '@/stores/settingsStore';
import MobileAgentHost from './MobileAgentHost';
import type { AgentTask } from '@/lib/types';

const TS = '2026-09-28T10:00:00.000Z';

// 只隔离原生边界与周边面板；数据全走真实 store（本用例断言的是子对话横条
// 怎么认「本机」子任务，必须让真实的 task/conversation store 参与）。
vi.mock('@/lib/tauri', () => ({
  // 挂载时 `syncActiveToConnection` 会拉一次会话列表：后端列表接口本来就过滤
  // 子 agent 对话，这里给空列表即可（active 保持在本用例设定的子对话上）。
  agentListConversationsByConnection: vi.fn().mockResolvedValue([]),
  agentLoadActiveMessages: vi.fn().mockResolvedValue({ messages: [], hasEarlier: false }),
  agentLoadPlansByConversation: vi.fn().mockResolvedValue([]),
  agentGetConversation: vi.fn().mockResolvedValue(null),
  agentDeleteMessageImage: vi.fn().mockResolvedValue(undefined),
  agentTruncateConversation: vi.fn().mockResolvedValue({
    deletedMessages: 0,
    planAdjusted: false,
    plan: null,
    planTaskId: null,
  }),
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
}));
// 当前 SSH 会话固定为一条已连接、已绑定保存连接的会话。
vi.mock('@/stores/sessionStore', async () => {
  const { create } = await import('zustand');
  return {
    useSessionStore: create(() => ({
      activeSessionId: 'session',
      sessions: {
        session: {
          id: 'session',
          configId: 'connection',
          connectionId: 'connection',
          status: 'connected',
          createdAt: '2026-09-28T10:00:00.000Z',
        },
      },
    })),
  };
});
vi.mock('@/stores/connectionStore', async () => {
  const { create } = await import('zustand');
  return {
    useConnectionStore: create(() => ({ connections: [], fetchConnections: vi.fn() })),
  };
});
// 周边面板/浮层与本用例无关：抹平成空组件，避免拖进整套依赖。
vi.mock('@/components/agent/AgentMessageList', () => ({ default: () => null }));
vi.mock('@/components/agent/PlanList', () => ({ default: () => null }));
vi.mock('@/components/agent/AgentCommandMenu', async () => {
  const { forwardRef } = await import('react');
  return { default: forwardRef(() => null) };
});
vi.mock('@/components/agent/ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('@/components/agent/ReasoningEffortPicker', () => ({
  ReasoningEffortPicker: () => null,
}));
vi.mock('./MobileActiveAgentsSheet', () => ({ default: () => null }));
vi.mock('./MobileApprovalSheet', () => ({ default: () => null }));
vi.mock('./MobileChatHistorySheet', () => ({ default: () => null }));
vi.mock('./MobileMultiHostPicker', () => ({ default: () => null }));

let host: HTMLDivElement;
let root: Root;

/** 把当前对话切到一条子对话，并挂上派发它的子任务（sessionId 由调用方给）。 */
function setActiveSubConversation(sessionId: string, mode: 'plan' | 'agent' = 'plan') {
  useConversationStore.setState({
    activeConversationId: 'sub',
    conversations: {
      main: {
        id: 'main',
        title: '主对话',
        connectionId: 'connection',
        createdAt: TS,
        updatedAt: TS,
      },
      sub: {
        id: 'sub',
        title: '调研子对话',
        connectionId: 'connection',
        createdAt: TS,
        updatedAt: TS,
        parentConversationId: 'main',
      },
    },
    messages: { main: [], sub: [] },
  });
  const parent: AgentTask = {
    id: 'parent',
    conversationId: 'main',
    sessionId: 'session',
    prompt: '看看这个仓库',
    mode: 'agent',
    status: 'executing',
    createdAt: TS,
  };
  const sub: AgentTask = {
    id: 'sub-task',
    conversationId: 'sub',
    sessionId,
    prompt: '读一下构建脚本',
    mode,
    status: 'executing',
    createdAt: TS,
    parentTaskId: 'parent',
  };
  useTaskStore.setState({
    activeTaskId: null,
    tasks: { [parent.id]: parent, [sub.id]: sub },
  });
}

async function render() {
  await act(async () => {
    root.render(<MobileAgentHost />);
  });
}

/** 子对话横条所在的块（「返回主对话」按钮的父级）。 */
function subConversationBarText(): string {
  const button = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.includes('返回主对话'),
  );
  if (!button) throw new Error('子对话横条没渲染出来');
  return button.parentElement?.textContent ?? '';
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useJobStore.setState(useJobStore.getInitialState(), true);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('移动端子对话横条 · 本机标记', () => {
  it('本机子任务（哨兵 sessionId）的子对话横条标出「本机」', async () => {
    setActiveSubConversation(LOCAL_SESSION_SENTINEL);

    await render();

    const bar = subConversationBarText();
    expect(bar).toContain('本机');
    expect(bar).toContain('子agent调研');
    expect(bar).toContain('调研子对话');
  });

  it('远端子任务（旧数据无 side）不出现「本机」，横条文案与从前一致', async () => {
    setActiveSubConversation('11111111-2222-4333-8444-555555555555');

    await render();

    const bar = subConversationBarText();
    expect(bar).not.toContain('本机');
    expect(bar).toContain('子agent调研');
    expect(bar).toContain('由主 Agent 派发的只读调研，不支持输入');
  });

  it('读写模式的远端子任务照旧显示「子agent执行」', async () => {
    setActiveSubConversation('11111111-2222-4333-8444-555555555555', 'agent');

    await render();

    const bar = subConversationBarText();
    expect(bar).toContain('子agent执行');
    expect(bar).not.toContain('本机');
  });
});
