// @vitest-environment jsdom
import { act, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgent } from './useAgent';
import { useAgentAttachments } from './useAgentAttachments';
import { useTaskStore } from '@/stores/taskStore';
import { draftKeyFor, resetAgentDrafts, useAgentDraftStore } from '@/stores/agentDraftStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUpdateStore } from '@/stores/updateStore';
import { createDefaultStreamHandler } from '@/stores/storeStreamAdapter';
import { cleanupStreamState, handleTextDelta } from '@/stores/agentStreamHandlers';
import { bus } from '@/plugins/injection/bus';
import { agentLoadActiveMessages, agentStopTask, installUpdateNow } from '@/lib/tauri';
import type { AgentConversation, AgentTask, AgentTaskPlan, ContextUsageEvent } from '@/lib/types';
import PlanList from '@/components/agent/PlanList';
import TerminalToolbar from '@/components/terminal/TerminalToolbar';
import UpdatePill from '@/components/layout/UpdatePill';

// 只隔离 IPC 和 SSH/xterm 边界；task/conversation store、流处理器和被测组件均为真实实现。
vi.mock('@/lib/tauri', () => ({
  agentCreateConversation: vi.fn(),
  agentDeleteConversation: vi.fn().mockResolvedValue(undefined),
  agentLoadActiveMessages: vi.fn(),
  agentLoadPlansByConversation: vi.fn().mockResolvedValue([]),
  agentStopTask: vi.fn().mockResolvedValue(undefined),
  installUpdateNow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/stores/sessionStore', async () => {
  const { create } = await import('zustand');
  return { useSessionStore: create(() => ({ activeSessionId: null, sessions: {} })) };
});

const CURRENT = 'subscription-current';
const BACKGROUND = 'subscription-background';
const currentTaskId = `task-${CURRENT}`;
const backgroundTaskId = `task-${BACKGROUND}`;
const timestamp = '2026-09-25T00:00:00.000Z';
const stream = createDefaultStreamHandler();

function conversation(id: string): AgentConversation {
  return { id, connectionId: 'connection', title: id, createdAt: timestamp, updatedAt: timestamp };
}

function task(conversationId: string): AgentTask {
  return {
    id: `task-${conversationId}`, conversationId, sessionId: 'session',
    prompt: 'prompt', mode: 'agent', status: 'executing', createdAt: timestamp,
  };
}

function plan(taskId: string, status: AgentTaskPlan['items'][number]['status'] = 'pending'): AgentTaskPlan {
  return { taskId, items: [{ id: '1', title: `step-${taskId}`, status }], currentIndex: 0 };
}

function usage(totalTokens: number): ContextUsageEvent {
  return {
    type: 'contextUsage', promptTokens: totalTokens - 10, completionTokens: 10, totalTokens,
    contextWindow: 1000, usedTokens: totalTokens - 10, estimated: false,
    systemTokens: 10, toolsTokens: 20, messageTokens: totalTokens - 40,
  };
}

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let agent: ReturnType<typeof useAgent>;
let agentRenders: number;
let actionRenders: number;
let commits: Record<string, number>;

function AgentConsumer() {
  agent = useAgent();
  agentRenders++;
  return <output>{agent.messages.map((m) => m.content).join('')}{agent.activeTask?.status}</output>;
}

function DraftConsumer() {
  agent = useAgent();
  const attachments = useAgentAttachments({
    conversationId: agent.draftConversationId,
    sessionId: 'session-1',
    visionEnabled: true,
    canInteract: true,
    sendUnavailableReason: agent.draftSendUnavailableReason,
  });
  return <output>{attachments.notice}</output>;
}

function FixedActionConsumer() {
  // 与 App 的固定 action 订阅相同；迁移时这个调用点随 App 一起改为所属 store。
  const setMode = useTaskStore((s) => s.setMode);
  actionRenders++;
  return <button onClick={() => setMode('plan')}>切换模式</button>;
}

function measured(id: string, child: ReactNode) {
  return <Profiler id={id} onRender={() => { commits[id] = (commits[id] ?? 0) + 1; }}>{child}</Profiler>;
}

async function mount(children: ReactNode) {
  await act(async () => { root.render(children); });
  agentRenders = 0;
  actionRenders = 0;
  commits = {};
}

async function textFrame(conversationId: string, text = 'x') {
  // 每帧独立 act，防止 React 把 100 次更新合并成一次而掩盖无关 render。
  await act(async () => {
    handleTextDelta(stream, `task-${conversationId}`, conversationId, `loading-${conversationId}`, {
      type: 'textDelta', text,
    });
    const pending = [...frames];
    frames.clear();
    for (const [id, callback] of pending) callback(id * 16);
  });
}

async function textFrames(conversationId: string) {
  for (let i = 0; i < 100; i++) await textFrame(conversationId);
  expect(frames.size).toBe(0);
}

function clickButton(text: string) {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  expect(button, `button: ${text}`).toBeDefined();
  button!.click();
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
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  resetAgentDrafts();
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useSessionStore.setState({ activeSessionId: null, sessions: {} });
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useUpdateStore.setState(useUpdateStore.getInitialState(), true);
  useConversationStore.setState({
    activeConversationId: CURRENT,
    conversations: { [CURRENT]: conversation(CURRENT), [BACKGROUND]: conversation(BACKGROUND) },
    messages: { [CURRENT]: [], [BACKGROUND]: [] },
  });
  useTaskStore.setState({
    activeTaskId: currentTaskId,
    tasks: { [currentTaskId]: task(CURRENT), [backgroundTaskId]: task(BACKGROUND) },
    plans: { [currentTaskId]: plan(currentTaskId), [backgroundTaskId]: plan(backgroundTaskId) },
  });
  useUpdateStore.setState({ state: { status: 'ready', version: '9.9.9' } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  agentRenders = 0;
  actionRenders = 0;
  commits = {};
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  cleanupStreamState(currentTaskId);
  cleanupStreamState(backgroundTaskId);
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Agent 订阅隔离（真实 store + stream + React 挂载）', () => {
  it.each([true, false])('同配置多标签同步空窗隔离草稿（目标已有绑定=%s）', async (hasBinding) => {
    useSessionStore.setState({
      activeSessionId: 'session-2',
      sessions: Object.fromEntries(['session-1', 'session-2'].map((id) => [id, {
        id, connectionId: 'connection', configId: 'connection', status: 'connected' as const, createdAt: timestamp,
      }])),
    });
    useConversationStore.setState({
      activeConversationBySession: {
        'session-1': CURRENT,
        ...(hasBinding ? { 'session-2': BACKGROUND } : {}),
      },
    });
    useAgentDraftStore.getState().setText(`conv:${CURRENT}`, '第一标签的草稿');
    await mount(<AgentConsumer />);

    expect(agent.draftKey).toBe('session:session-2');
    expect(agent.draftSendUnavailableReason).toBe('会话尚未就绪，可继续编辑并添加附件');
    await act(async () => { agent.setInputDraft('第二标签正在输入'); });
    expect(useAgentDraftStore.getState().getDraft(`conv:${CURRENT}`).text).toBe('第一标签的草稿');
    expect(useAgentDraftStore.getState().getDraft('session:session-2').text).toBe('第二标签正在输入');

    await act(async () => {
      useConversationStore.setState({
        activeConversationId: BACKGROUND,
        activeConversationBySession: { 'session-1': CURRENT, 'session-2': BACKGROUND },
      });
    });
    expect(agent.draftKey).toBe(`conv:${BACKGROUND}`);
    expect(agent.draftSendUnavailableReason).toBeNull();
  });

  it('当前标签打开自己的子对话时保留该子对话的草稿归属', async () => {
    useSessionStore.setState({
      activeSessionId: 'session-1',
      sessions: { 'session-1': {
        id: 'session-1', connectionId: 'connection', configId: 'connection', status: 'connected', createdAt: timestamp,
      } },
    });
    useConversationStore.setState((state) => ({
      activeConversationId: 'child',
      activeConversationBySession: { 'session-1': CURRENT },
      conversations: { ...state.conversations, child: { ...conversation('child'), parentConversationId: CURRENT } },
    }));
    await mount(<AgentConsumer />);
    expect(agent.draftKey).toBe('conv:child');
    expect(agent.draftSendUnavailableReason).toBeNull();
  });

  it('删除后空闲历史已成为可见草稿时，恢复失败提示仍出现在当前输入区', async () => {
    useSessionStore.setState({
      activeSessionId: 'session-1',
      sessions: Object.fromEntries(['session-1', 'session-2'].map((id) => [id, {
        id, connectionId: 'connection', configId: 'connection', status: 'connected' as const, createdAt: timestamp,
      }])),
    });
    useConversationStore.setState({
      activeConversationBySession: { 'session-1': CURRENT, 'session-2': 'occupied' },
      activeConversationByConnection: { connection: CURRENT },
      conversations: {
        [CURRENT]: conversation(CURRENT),
        [BACKGROUND]: { ...conversation(BACKGROUND), updatedAt: '2026-09-26T00:00:00.000Z' },
        occupied: conversation('occupied'),
      },
    });
    useTaskStore.setState({ tasks: {}, activeTaskId: null, plans: {}, compacting: {} });
    let rejectLoad!: (reason: unknown) => void;
    const pending = new Promise<Awaited<ReturnType<typeof agentLoadActiveMessages>>>((_, reject) => { rejectLoad = reject; });
    vi.mocked(agentLoadActiveMessages).mockReturnValueOnce(pending);
    await mount(<DraftConsumer />);
    let deletion!: Promise<void>;
    await act(async () => {
      deletion = useConversationStore.getState().deleteConversation(CURRENT);
      await vi.waitFor(() => expect(agentLoadActiveMessages).toHaveBeenCalledWith(BACKGROUND));
    });
    expect(agent.draftKey).toBe(`conv:${BACKGROUND}`);
    await act(async () => {
      rejectLoad({ kind: 'Io', message: '历史暂时无法读取' });
      await deletion;
    });

    expect(host.textContent).toContain('历史暂时无法读取');
    expect(host.textContent).toContain('会话已删除');
    expect(useAgentDraftStore.getState().getDraft('session:session-1').notice).toBeNull();
    expect(useConversationStore.getState().conversations[CURRENT]).toBeUndefined();
  });

  it('固定 action 消费者不随后台 100 个流帧重渲染', async () => {
    await mount(<FixedActionConsumer />);
    await textFrames(BACKGROUND);
    expect(useConversationStore.getState().messages[BACKGROUND][0].content).toBe('x'.repeat(100));
    expect(actionRenders).toBe(0);
  });

  it('desktop/mobile 共用 hook 不随后台 100 个流帧重渲染', async () => {
    await mount(<AgentConsumer />);
    const currentMessages = agent.messages;
    await textFrames(BACKGROUND);
    expect(useConversationStore.getState().messages[BACKGROUND][0].content).toBe('x'.repeat(100));
    expect(agent.messages).toBe(currentMessages);
    expect(agentRenders).toBe(0);
  });

  it('真实计划、工具栏、更新药丸不随后台 100 个流帧提交', async () => {
    await mount(<>
      {measured('plan', <PlanList />)}
      {measured('toolbar', <TerminalToolbar />)}
      {measured('update', <UpdatePill />)}
    </>);
    await textFrames(BACKGROUND);
    expect({ plan: commits.plan ?? 0, toolbar: commits.toolbar ?? 0, update: commits.update ?? 0 })
      .toEqual({ plan: 0, toolbar: 0, update: 0 });
  });

  it('后台任务、计划和用量更新也不唤醒当前 hook 或无关组件', async () => {
    await mount(<>
      <AgentConsumer />
      <FixedActionConsumer />
      {measured('plan', <PlanList />)}
      {measured('toolbar', <TerminalToolbar />)}
      {measured('update', <UpdatePill />)}
    </>);
    await act(async () => { stream.updateTaskStatus(backgroundTaskId, 'waiting_approval'); });
    await act(async () => { stream.setPlan(backgroundTaskId, plan(backgroundTaskId, 'in_progress')); });
    await act(async () => { stream.recordContextUsage(BACKGROUND, usage(120)); });
    expect({ agentRenders, actionRenders, ...commits }).toEqual({ agentRenders: 0, actionRenders: 0 });
  });

  it('当前会话的 100 个流帧逐帧显示，输入和模式立即更新', async () => {
    await mount(<AgentConsumer />);
    for (let i = 1; i <= 100; i++) {
      await textFrame(CURRENT);
      expect(host.textContent).toBe(`${'x'.repeat(i)}executing`);
    }
    expect(agentRenders).toBe(100);
    await act(async () => { agent.setInputDraft('draft'); });
    expect(agent.inputDraft).toBe('draft');
    await act(async () => { agent.setInputDraft((previous) => `${previous}+append`); });
    expect(agent.inputDraft).toBe('draft+append');
    await act(async () => { agent.setMode('plan'); });
    expect(agent.mode).toBe('plan');
  });

  it('任务状态与切换立即更新，停止调用当前任务，活动桥仍只发布 running', async () => {
    const activity = vi.spyOn(bus, 'emit');
    await mount(<AgentConsumer />);
    expect(activity).toHaveBeenLastCalledWith('ui://agent-activity', { running: true });
    await act(async () => { stream.updateTaskStatus(currentTaskId, 'waiting_approval'); });
    expect(agent.activeTask?.status).toBe('waiting_approval');
    expect(agent.isRunning).toBe(true);
    await act(async () => { useTaskStore.setState({ activeTaskId: backgroundTaskId }); });
    expect(agent.activeTask?.id).toBe(backgroundTaskId);
    await act(async () => { await agent.stopActiveTask(); });
    expect(agentStopTask).toHaveBeenCalledWith(backgroundTaskId);
    expect(agent.activeTask).toBeNull();
    expect(agent.isRunning).toBe(false);
    expect(activity).toHaveBeenLastCalledWith('ui://agent-activity', { running: false });
  });

  it('用量保持实时优先、持久化兜底，元数据变化仍传给双端', async () => {
    const persisted = { promptTokens: 50, completionTokens: 10, totalTokens: 60 };
    useConversationStore.setState((s) => ({ conversations: {
      ...s.conversations, [CURRENT]: { ...s.conversations[CURRENT], usage: persisted, contextWindow: 500 },
    } }));
    await mount(<AgentConsumer />);
    expect(agent.activeUsageView).toEqual({ usage: persisted, windowTokens: 500 });
    await act(async () => { stream.recordContextUsage(CURRENT, usage(120)); });
    expect(agent.activeUsageView?.usage.totalTokens).toBe(120);
    expect(agent.activeUsageView?.windowTokens).toBe(1000);
    await act(async () => { useConversationStore.setState((s) => ({ conversations: {
      ...s.conversations, [CURRENT]: { ...s.conversations[CURRENT], title: 'renamed', contextWindow: 2000 },
    } })); });
    expect(agent.conversations[CURRENT].title).toBe('renamed');
    expect(agent.activeUsageView?.windowTokens).toBe(1000);
  });

  it('真实切换恢复目标消息、任务、计划与用量，之后原会话流帧不再触发 hook', async () => {
    await textFrame(CURRENT, 'current');
    await textFrame(BACKGROUND, 'background');
    stream.recordContextUsage(CURRENT, usage(120));
    stream.recordContextUsage(BACKGROUND, usage(240));
    await mount(<><AgentConsumer /><PlanList /></>);
    await act(async () => { await agent.switchConversation(BACKGROUND); });
    expect(agent.activeConversationId).toBe(BACKGROUND);
    expect(agent.activeTask?.id).toBe(backgroundTaskId);
    expect(agent.messages[0].content).toBe('background');
    expect(agent.activeUsageView?.usage.totalTokens).toBe(240);
    expect(host.textContent).toContain(`step-${backgroundTaskId}`);
    expect(host.textContent).not.toContain(`step-${currentTaskId}`);
    agentRenders = 0;
    await textFrames(CURRENT);
    expect(agentRenders).toBe(0);
    expect(agent.messages[0].content).toBe('background');
  });

  it.each([null, 'unloaded-conversation'])('空/未加载会话 %s 使用稳定空消息，读取不清空原数据', async (id) => {
    useConversationStore.setState({ activeConversationId: id });
    useTaskStore.setState({ activeTaskId: 'missing-task' });
    useAgentDraftStore.getState().setText(draftKeyFor(id, null), 'keep draft');
    const conversationsBefore = useConversationStore.getState();
    const tasksBefore = useTaskStore.getState();
    await mount(<><AgentConsumer /><PlanList /></>);
    expect(agent.messages).toEqual([]);
    expect(agent.activeTask).toBeNull();
    expect(agent.activeUsageView).toBeNull();
    expect(agent.isRunning).toBe(false);
    expect(useConversationStore.getState()).toBe(conversationsBefore);
    expect(useTaskStore.getState()).toBe(tasksBefore);
    const emptyMessages = agent.messages;
    await act(async () => { agent.setInputDraft('edited draft'); });
    expect(agent.messages).toBe(emptyMessages);
    expect(useConversationStore.getState()).toBe(conversationsBefore);
  });

  it('计划更新、自动折叠、任务终态隐藏及历史占位计划保持原语义', async () => {
    await mount(<PlanList />);
    expect(host.textContent).toContain(`step-${currentTaskId}`);
    await act(async () => { stream.setPlan(currentTaskId, plan(currentTaskId, 'in_progress')); });
    expect(host.textContent).toContain('当前');
    await act(async () => { stream.setPlan(currentTaskId, plan(currentTaskId, 'completed')); });
    expect(host.textContent).toContain('1/1');
    expect(host.textContent).not.toContain(`step-${currentTaskId}`);
    await act(async () => { host.querySelector('button')!.click(); });
    expect(host.textContent).toContain(`step-${currentTaskId}`);
    await act(async () => { stream.updateTaskStatus(currentTaskId, 'completed'); });
    expect(host.textContent).toBe('');
    await act(async () => {
      useTaskStore.getState().loadPersistedPlans(CURRENT, [{
        taskId: 'persisted-task', plan: plan('persisted-task', 'in_progress'),
        updatedAt: '2026-09-25T01:00:00.000Z',
      }]);
    });
    expect(host.textContent).toContain('step-persisted-task');
  });

  it('工具栏点击切换模式当场生效', async () => {
    await mount(<TerminalToolbar />);
    const planButton = host.querySelector<HTMLButtonElement>('button');
    expect(planButton).not.toBeNull();
    await act(async () => { planButton!.click(); });
    expect(useTaskStore.getState().mode).toBe('plan');
    expect(planButton!.className).toContain('bg-indigo-600');
  });

  it('更新药丸仍跟随当前任务 busy，安装确认不会被订阅优化跳过', async () => {
    useTaskStore.setState({ activeTaskId: null });
    await mount(<UpdatePill />);
    await act(async () => { useTaskStore.setState({ activeTaskId: currentTaskId }); });
    await act(async () => { clickButton('✓ 9.9.9'); });
    await act(async () => { clickButton('立即重启更新'); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('现在安装更新？');
    expect(installUpdateNow).not.toHaveBeenCalled();
    await act(async () => { clickButton('确认安装'); });
    expect(installUpdateNow).toHaveBeenCalledOnce();
  });
});
