// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentPanel from '@/components/agent/AgentPanel';
import MobileAgentHost from '@/mobile/MobileAgentHost';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useJobStore } from '@/stores/jobStore';
import { createDefaultStreamHandler } from '@/stores/storeStreamAdapter';
import { cleanupStreamState, handleTextDelta } from '@/stores/agentStreamHandlers';
import { agentTruncateConversation } from '@/lib/tauri';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { AgentMessage } from '@/lib/types';

const counts = vi.hoisted(() => ({ host: 0, markdown: new Map<string, number>() }));

// 计数后调用真实 hook 和 Markdown 解析器；宿主、列表、消息 memo 均不替换。
vi.mock('@/hooks/useAgent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAgent')>();
  return { useAgent: (...args: Parameters<typeof actual.useAgent>) => { counts.host++; return actual.useAgent(...args); } };
});
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return { ...actual, default: (props: ComponentProps<typeof actual.default>) => {
    const text = props.children ?? '';
    counts.markdown.set(text, (counts.markdown.get(text) ?? 0) + 1);
    return actual.default(props);
  } };
});

// 只隔离原生边界与本场景未操作的周边面板，避免加载 xterm/插件窗口。
vi.mock('@/lib/tauri', () => ({
  agentDeleteMessageImage: vi.fn().mockResolvedValue(undefined),
  agentTruncateConversation: vi.fn().mockResolvedValue({
    deletedMessages: 4, planAdjusted: false, plan: null, planTaskId: null,
  }),
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/stores/sessionStore', async () => {
  const { create } = await import('zustand');
  return { useSessionStore: create(() => ({
    activeSessionId: 'session', sessions: { session: {
      id: 'session', configId: 'connection', connectionId: 'connection',
      status: 'connected', createdAt: '2026-09-25T00:00:00.000Z',
    } },
  })) };
});
vi.mock('@/stores/connectionStore', async () => {
  const { create } = await import('zustand');
  return { useConnectionStore: create(() => ({ connections: [], fetchConnections: vi.fn() })) };
});
vi.mock('@/components/settings/ChatHistoryModal', () => ({ default: () => null }));
vi.mock('@/components/agent/AgentTasksDrawer', () => ({ AgentTasksDrawer: () => null }));
vi.mock('@/components/agent/MultiHostPicker', () => ({ default: () => null }));
vi.mock('@/components/agent/AgentCommandMenu', async () => {
  const { forwardRef } = await import('react');
  return { default: forwardRef(() => null) };
});
vi.mock('@/components/agent/ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('@/components/agent/ReasoningEffortPicker', () => ({ ReasoningEffortPicker: () => null }));
vi.mock('@/mobile/MobileActiveAgentsSheet', () => ({ default: () => null }));
vi.mock('@/mobile/MobileApprovalSheet', () => ({ default: () => null }));
vi.mock('@/mobile/MobileQuestionSheet', () => ({ default: () => null }));
vi.mock('@/mobile/MobileChatHistorySheet', () => ({ default: () => null }));
vi.mock('@/mobile/MobileMultiHostPicker', () => ({ default: () => null }));

const CURRENT = 'host-current';
const BACKGROUND = 'host-background';
const STATIC_MARKDOWN = '**静态答案**：这条历史消息不随流更新。';
const timestamp = '2026-09-25T00:00:00.000Z';
const stream = createDefaultStreamHandler();
let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function resetCounts() {
  counts.host = 0;
  counts.markdown.clear();
}

function flushFrames() {
  const pending = [...frames];
  frames.clear();
  for (const [id, callback] of pending) callback(id * 16);
}

async function textFrames(conversationId: string) {
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      handleTextDelta(stream, `task-${conversationId}`, conversationId, 'loading', { type: 'textDelta', text: 'x' });
      flushFrames();
    });
  }
}

async function mount(Host: typeof AgentPanel | typeof MobileAgentHost) {
  await act(async () => { root.render(<Host />); });
  expect(host.querySelector('[data-message-id="static"]')?.textContent).toContain('静态答案');
  resetCounts();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useJobStore.setState(useJobStore.getInitialState(), true);
  const messages: AgentMessage[] = [
    { id: 'user', role: 'user', content: '恢复这个问题', timestamp },
    { id: 'static', role: 'assistant', content: STATIC_MARKDOWN, timestamp },
    { id: 'loading', role: 'assistant', content: '', timestamp, isLoading: true },
  ];
  useConversationStore.setState({
    activeConversationId: CURRENT,
    activeConversationBySession: { session: CURRENT },
    conversations: Object.fromEntries([CURRENT, BACKGROUND].map((id) => [id, {
      id, title: id, connectionId: 'connection', createdAt: timestamp, updatedAt: timestamp,
    }])),
    messages: { [CURRENT]: messages, [BACKGROUND]: [] },
  });
  useTaskStore.setState({
    activeTaskId: `task-${CURRENT}`,
    tasks: Object.fromEntries([CURRENT, BACKGROUND].map((conversationId) => [`task-${conversationId}`, {
      id: `task-${conversationId}`, conversationId, sessionId: 'session',
      prompt: 'prompt', mode: 'agent', status: 'executing', createdAt: timestamp,
    }])),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  resetCounts();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  cleanupStreamState(`task-${CURRENT}`);
  cleanupStreamState(`task-${BACKGROUND}`);
  host.remove();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.unstubAllGlobals();
});

describe.each([['desktop', AgentPanel], ['mobile', MobileAgentHost]] as const)('%s 真实宿主与消息列表', (_platform, Host) => {
  it('后台 100 帧不唤醒宿主，也不重解析历史 Markdown', async () => {
    await mount(Host);
    await textFrames(BACKGROUND);
    expect(useConversationStore.getState().messages[BACKGROUND][0].content).toBe('x'.repeat(100));
    expect(counts.host).toBe(0);
    expect(counts.markdown.get(STATIC_MARKDOWN) ?? 0).toBe(0);
  });

  it('当前 100 帧持续更新，静态历史 Markdown 不重复解析', async () => {
    await mount(Host);
    await textFrames(CURRENT);
    expect(host.textContent).toContain('x'.repeat(100));
    expect(counts.host).toBe(0);
    expect(counts.markdown.get(STATIC_MARKDOWN) ?? 0).toBe(0);
  });

  it('输入草稿立即更新且不重解析历史 Markdown', async () => {
    await mount(Host);
    await act(async () => { useTaskStore.getState().setInputDraft('new draft'); });
    expect(host.querySelector('textarea')?.value).toBe('new draft');
    expect(counts.host).toBe(0);
    expect(counts.markdown.get(STATIC_MARKDOWN) ?? 0).toBe(0);
  });

  it('十次打字只测高十次，不刷新宿主；外部恢复草稿也自动测高', async () => {
    await mount(Host);
    const input = host.querySelector('textarea')!;
    let reads = 0;
    Object.defineProperty(input, 'scrollHeight', { get: () => { reads++; return 48; } });
    for (let i = 1; i <= 10; i++) {
      await act(async () => {
        input.value = 'x'.repeat(i);
        Simulate.change(input);
      });
    }
    expect(reads).toBe(10);
    expect(counts.host).toBe(0);
    await act(async () => { useTaskStore.getState().setInputDraft('restored\ntext'); });
    expect(input.value).toBe('restored\ntext');
    expect(reads).toBe(11);
  });

  it('回调稳定后复制、撤回仍用当前消息，压缩占位及时禁用操作', async () => {
    await mount(Host);
    const copy = host.querySelector<HTMLButtonElement>('[data-message-id="user"] button[title="复制消息"]');
    await act(async () => { copy!.click(); });
    expect(writeText).toHaveBeenCalledWith('恢复这个问题');
    await act(async () => {
      useTaskStore.getState().updateTaskStatus(`task-${CURRENT}`, 'completed');
      useTaskStore.getState().clearActiveTask();
      useTaskStore.getState().beginCompaction(CURRENT);
    });
    const rollback = host.querySelector<HTMLButtonElement>('[data-message-id="user"] button');
    expect(rollback?.disabled).toBe(true);
    expect(host.querySelector('[aria-label="取消压缩"]')).not.toBeNull();
    await act(async () => { useTaskStore.getState().endCompaction(CURRENT); });
    expect(rollback?.disabled).toBe(false);
    await act(async () => { rollback!.click(); });
    expect(agentTruncateConversation).toHaveBeenCalledWith(CURRENT, timestamp);
    expect(host.querySelector('textarea')?.value).toBe('恢复这个问题');
  });
});
