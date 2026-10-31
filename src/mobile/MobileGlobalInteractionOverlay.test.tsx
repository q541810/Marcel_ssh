// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
import type { ActiveInteractionPayload, AgentTask, QuestionItem } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不实现 ResizeObserver，而 MobileSheet 用它测拖拽高度 —— 补个空壳即可，
// 这里断言的是跳转落点，不涉及尺寸。
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mocks = vi.hoisted(() => ({
  tasks: {} as Record<string, AgentTask>,
  interaction: null as ActiveInteractionPayload | null,
  activeSessionId: null as string | null,
  setActiveSession: vi.fn(),
  switchConversation: vi.fn(async (_id: string) => {}),
  activeConversationId: null as string | null,
  approve: vi.fn(async () => {}),
  reject: vi.fn(async () => {}),
  answerQuestion: vi.fn(async () => {}),
  stopTask: vi.fn(async () => {}),
  privacy: false,
}));

vi.mock('@/hooks/usePrivacyMode', () => ({
  usePrivacyMode: () => mocks.privacy,
}));

// 只替换数据来源：本用例断言的是「跳转跳到哪条会话」，与被替换的 store 实现无关。
vi.mock('@/stores/interactionStore', () => ({
  useInteractionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      currentInteraction: mocks.interaction,
      approve: mocks.approve,
      reject: mocks.reject,
      answerQuestion: mocks.answerQuestion,
    }),
}));
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ activeSessionId: mocks.activeSessionId, setActiveSession: mocks.setActiveSession }),
}));
// 跳转入口统一经 openConversation（同时更新机器与对话的绑定）；本文件只关心「跳到哪条对话」。
vi.mock('@/stores/sessionConversationBindingManager', () => ({
  sessionConversationBindingManager: { openConversation: (id: string) => mocks.switchConversation(id) },
}));
vi.mock('@/stores/conversationStore', () => ({
  useConversationStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeConversationId: mocks.activeConversationId,
      switchConversation: mocks.switchConversation,
    }),
}));
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ stopTask: mocks.stopTask }),
    { getState: () => ({ tasks: mocks.tasks }) },
  ),
}));

import MobileGlobalInteractionOverlay from './MobileGlobalInteractionOverlay';
import './backHandler';
import { useVisibleTranscriptStore } from '@/stores/visibleTranscriptStore';
import { useMessageJumpStore } from '@/stores/messageJumpStore';

const TS = '2026-09-28T10:00:00.000Z';
const SUB_CONV = 'conv-sub';
const MAIN_CONV = 'conv-main';
const PARENT_SESSION = 'session-real';
const OTHER_SESSION = 'session-other';
const REAL_HOST = '203.0.113.7';

const PARENT_TASK: AgentTask = {
  id: 'task-parent',
  sessionId: PARENT_SESSION,
  conversationId: MAIN_CONV,
  prompt: '派本机子 agent',
  mode: 'agent',
  status: 'executing',
  createdAt: TS,
};

/** 本机子 agent 的任务：`sessionId` 是哨兵，父任务在主 agent 的真会话上。 */
const LOCAL_SUB_TASK: AgentTask = {
  id: 'sub-local',
  sessionId: LOCAL_SESSION_SENTINEL,
  conversationId: SUB_CONV,
  prompt: '盘点磁盘',
  mode: 'plan',
  status: 'executing',
  createdAt: TS,
  parentTaskId: 'task-parent',
};

/** 本机子 agent 里触发的审批：sessionId 是哨兵、对话是那条子对话。 */
function localApproval(
  overrides: Partial<ActiveInteractionPayload> = {},
): ActiveInteractionPayload {
  return {
    type: 'interactionActive',
    interactionId: 'int-local',
    kind: 'approval',
    taskId: 'sub-local',
    sessionId: LOCAL_SESSION_SENTINEL,
    conversationId: SUB_CONV,
    conversationTitle: '盘点磁盘（子agent）',
    queueLength: 1,
    approval: {
      toolCallId: 'call-1',
      toolName: 'local_bash',
      arguments: { command: 'Get-ChildItem' },
      disposition: 'ForceApproval',
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tasks = { 'sub-local': LOCAL_SUB_TASK, 'task-parent': PARENT_TASK };
  mocks.interaction = null;
  mocks.activeSessionId = null;
  mocks.activeConversationId = null;
  mocks.privacy = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // MobileSheet 用 createPortal 挂到 body 上：卸载后清掉残留节点，免得下一条
  // 用例查到上一条的 DOM。
  document.body.innerHTML = '';
});

function render() {
  act(() => {
    root.render(<MobileGlobalInteractionOverlay />);
  });
}

function buttonByText(label: string): HTMLButtonElement | null {
  const el = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  return el ?? null;
}

function clickButton(label: string) {
  const el = buttonByText(label);
  if (!el) throw new Error(`找不到按钮：${label}`);
  act(() => {
    el.click();
  });
}

/** 收成浮动条（标题栏那个「收起为浮动条」，不算作答）。 */
function minimize() {
  const el = document.body.querySelector<HTMLButtonElement>('button[title="收起为浮动条"]');
  if (!el) throw new Error('找不到「收起为浮动条」按钮');
  act(() => {
    el.click();
  });
}

/**
 * 隐私模式：提问 / 审批面板与收起后的浮动条都显示会话地址，必须跟着隐私开关走
 * （以前后端把 `user@真实IP:端口` 拼成字符串直接下发，面板原样显示、脱敏不生效）。
 * 与桌面 `GlobalInteractionOverlay.test.tsx` 同一组用例、同一口径。
 */
describe('隐私模式下的会话地址', () => {
  const ASK = [{ header: '方案', question: '走哪条', multiple: false, options: [] }] as QuestionItem[];
  const text = () => document.body.textContent ?? '';

  it('关闭：提问提醒条显示真实地址', () => {
    mocks.interaction = questionInteraction(ASK);
    render();
    expect(text()).toContain(`jinye@${REAL_HOST}:2222`);
  });

  it('开启：提问提醒条只剩脱敏地址，真实 IP / 端口不出现在 DOM 里', () => {
    mocks.privacy = true;
    mocks.interaction = questionInteraction(ASK);
    render();
    expect(text()).toContain('jinye@***:****');
    expect(text()).not.toContain(REAL_HOST);
    expect(text()).not.toContain('2222');
  });

  it('提醒条显示时切换开关：立即跟着变', () => {
    mocks.interaction = questionInteraction(ASK);
    render();
    expect(text()).toContain(REAL_HOST);

    mocks.privacy = true;
    render();
    expect(text()).not.toContain(REAL_HOST);
    expect(text()).toContain('jinye@***:****');
  });

  it('没有 SSH 目标（本机交互）：显示「SSH 会话」兜底', () => {
    mocks.privacy = true;
    mocks.interaction = localApproval();
    render();
    expect(text()).toContain('SSH 会话');
  });
});

/**
 * 本机（哨兵）交互的跳转落点：**只**从组件外部断言（渲染 → 收起 → 点「跳转」），
 * 不导出内部判定函数 —— 组件文件多一个非组件导出会破掉 fast refresh。
 * 与桌面 `GlobalInteractionOverlay.test.tsx` 同一组用例、同一口径。
 */
describe('本机交互（本机子 agent 的审批）的跳转与「当前上下文」', () => {
  it('用户不在那条子对话里 → 浮动条给「跳转」，点了跳到父 agent 的 SSH 会话（不是哨兵）', () => {
    mocks.interaction = localApproval();
    mocks.activeConversationId = MAIN_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    expect(buttonByText('跳转')).not.toBeNull();
    clickButton('跳转');

    expect(mocks.setActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.setActiveSession).toHaveBeenCalledWith(PARENT_SESSION);
    expect(mocks.setActiveSession).not.toHaveBeenCalledWith(LOCAL_SESSION_SENTINEL);
    expect(mocks.switchConversation).toHaveBeenCalledWith(SUB_CONV);
  });

  it('用户已在那条子对话里 → 浮动条不再提示「跳转」（本机没有会话可比，只比对话）', () => {
    mocks.interaction = localApproval();
    mocks.activeConversationId = SUB_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    expect(buttonByText('跳转')).toBeNull();
  });

  it('父任务记录缺失 → 跳转只切对话，不切会话（终端原地不动）', () => {
    mocks.tasks = { 'sub-local': LOCAL_SUB_TASK };
    mocks.interaction = localApproval();
    mocks.activeConversationId = MAIN_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    clickButton('跳转');

    expect(mocks.setActiveSession).not.toHaveBeenCalled();
    expect(mocks.switchConversation).toHaveBeenCalledWith(SUB_CONV);
  });

  it('本次交互自己的 sessionId 是空串（重启恢复）→ 不切会话（与旧行为一致）', () => {
    mocks.interaction = localApproval({ sessionId: '', conversationId: MAIN_CONV });
    mocks.activeConversationId = 'conv-other';
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    clickButton('跳转');

    expect(mocks.setActiveSession).not.toHaveBeenCalled();
    expect(mocks.switchConversation).toHaveBeenCalledWith(MAIN_CONV);
  });

  it('远端交互照旧：会话 + 对话都切（旧行为不回归）', () => {
    mocks.interaction = localApproval({
      interactionId: 'int-remote',
      taskId: 'task-remote',
      sessionId: 'session-remote',
      conversationId: 'conv-remote',
    });
    mocks.activeConversationId = MAIN_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    clickButton('跳转');

    expect(mocks.setActiveSession).toHaveBeenCalledWith('session-remote');
    expect(mocks.switchConversation).toHaveBeenCalledWith('conv-remote');
  });
});

/** 远端会话的提问交互（形状照 2026-10-06 的真实崩溃载荷）。 */
function questionInteraction(
  questions: QuestionItem[],
  overrides: Partial<ActiveInteractionPayload> = {},
): ActiveInteractionPayload {
  return {
    type: 'interactionActive',
    interactionId: 'int-q',
    kind: 'question',
    taskId: 'task-remote',
    sessionId: 'session-remote',
    conversationId: 'conv-remote',
    sessionTarget: { username: 'jinye', host: REAL_HOST, port: 2222 },
    conversationTitle: 'new.neopig.top 开 api 站',
    queueLength: 2,
    question: { questionId: 'q-1', questions },
    ...overrides,
  };
}

/**
 * 提问不再是盖住聊天的上拉面板：它所属对话正显示在聊天页里 → 内联在聊天末尾（本组件什么
 * 都不画）；否则只留一条提醒条，点它切到聊天页、打开对话并落到提问前的结论。
 * 答题表单（含 2026-10-06 的换题崩溃回归）的用例在 MobileQuestionSheet.test.tsx。
 */
describe('提问的内联 / 提醒条分流', () => {
  const ASK: QuestionItem[] = [{ header: '方案', question: '走哪条', multiple: false, options: [] }];
  const bar = () => document.body.querySelector('[data-region="mobile-question-bar"]');

  afterEach(() => {
    useVisibleTranscriptStore.setState({ byInstance: {} });
    useMessageJumpStore.setState({ request: null });
  });

  it('对话不在聊天页可见 → 只出提醒条，没有答题表单也没有返回键占用', () => {
    mocks.interaction = questionInteraction(ASK);
    render();
    expect(bar()).not.toBeNull();
    expect(document.body.querySelector('textarea')).toBeNull();
    expect(window.__marcelHandleBack?.()).toBe(false);
  });

  it('对话正显示在聊天页里 → 本组件不画任何东西（提问已内联）', () => {
    mocks.interaction = questionInteraction(ASK);
    useVisibleTranscriptStore.getState().register('t1', 'conv-remote');
    render();
    expect(bar()).toBeNull();
    expect(document.body.textContent).toBe('');
  });

  it('聊天页显示的是别的对话 → 仍是提醒条', () => {
    mocks.interaction = questionInteraction(ASK);
    useVisibleTranscriptStore.getState().register('t1', 'conv-other');
    render();
    expect(bar()).not.toBeNull();
  });

  it('点提醒条：切到聊天页 + 打开该对话 + 发出跳转到上文的请求', () => {
    mocks.interaction = questionInteraction(ASK);
    mocks.activeConversationId = MAIN_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    const tabs: string[] = [];
    const onTab = (e: Event) => tabs.push((e as CustomEvent<{ tab: string }>).detail.tab);
    window.addEventListener('mobile:switch-tab', onTab);
    render();
    act(() => {
      (bar()!.querySelector('button') as HTMLButtonElement).click();
    });
    window.removeEventListener('mobile:switch-tab', onTab);

    expect(tabs).toEqual(['agent']);
    expect(mocks.switchConversation).toHaveBeenCalledWith('conv-remote');
    expect(mocks.setActiveSession).toHaveBeenCalledWith('session-remote');
    const req = useMessageJumpStore.getState().request;
    expect(req).toMatchObject({ conversationId: 'conv-remote', toolCallId: 'q-1' });
  });
});
