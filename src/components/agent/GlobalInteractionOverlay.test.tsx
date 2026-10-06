// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
import type { ActiveInteractionPayload, AgentTask, QuestionItem } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  tasks: {} as Record<string, AgentTask>,
  interaction: null as ActiveInteractionPayload | null,
  activeSessionId: null as string | null,
  setActiveSession: vi.fn(),
  switchConversation: vi.fn(async () => {}),
  activeConversationId: null as string | null,
  approve: vi.fn(async () => {}),
  reject: vi.fn(async () => {}),
  answerQuestion: vi.fn(async () => {}),
  stopTask: vi.fn(async () => {}),
  fly: vi.fn(),
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
// 飞入动画要 Web Animations API（jsdom 没有）：本用例验的是跳转，动画换成桩。
vi.mock('@/stores/capsuleFlyAnimation', () => ({
  flyToInteractionCapsule: mocks.fly,
  registerCapsuleTarget: () => {},
}));

import GlobalInteractionOverlay from './GlobalInteractionOverlay';

const TS = '2026-09-28T10:00:00.000Z';
const SUB_CONV = 'conv-sub';
const MAIN_CONV = 'conv-main';
const PARENT_SESSION = 'session-real';
const OTHER_SESSION = 'session-other';

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
    sessionName: 'SSH 会话',
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

/** 远端会话的提问交互：questions 由调用方给定（形状照 2026-10-06 的真实崩溃载荷）。 */
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
    sessionName: 'jinye',
    conversationTitle: 'new.neopig.top 开 api 站',
    queueLength: 2,
    question: { questionId: 'q-1', questions },
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<GlobalInteractionOverlay />);
  });
}

function clickButton(label: string) {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`找不到按钮：${label}`);
  act(() => {
    el.click();
  });
}

/** 选项按钮的文本带着 description（`A选项说明`），按标签前缀找。 */
function clickOption(label: string) {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim().startsWith(label),
  );
  if (!el) throw new Error(`找不到选项：${label}`);
  act(() => {
    el.click();
  });
}

/** 收成右下角浮动胶囊（标题栏那个「收起」，不算作答）。 */
function minimize() {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="收起"]');
  if (!el) throw new Error('找不到「收起」按钮');
  act(() => {
    el.click();
  });
}

function hasButton(label: string): boolean {
  return Array.from(container.querySelectorAll('button')).some(
    (b) => b.textContent?.trim() === label,
  );
}

/**
 * 本机（哨兵）交互的跳转落点：**只**从组件外部断言（渲染 → 收起 → 点「跳转」），
 * 不导出内部判定函数 —— 组件文件多一个非组件导出会破掉 fast refresh。
 */
describe('本机交互（本机子 agent 的审批）的跳转与「当前上下文」', () => {
  it('用户不在那条子对话里 → 胶囊给「跳转」，点了跳到父 agent 的 SSH 会话（不是哨兵）', () => {
    mocks.interaction = localApproval();
    mocks.activeConversationId = MAIN_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    expect(hasButton('跳转')).toBe(true);
    clickButton('跳转');

    expect(mocks.setActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.setActiveSession).toHaveBeenCalledWith(PARENT_SESSION);
    expect(mocks.setActiveSession).not.toHaveBeenCalledWith(LOCAL_SESSION_SENTINEL);
    expect(mocks.switchConversation).toHaveBeenCalledWith(SUB_CONV);
  });

  it('用户已在那条子对话里 → 胶囊不再提示「跳转」（本机没有会话可比，只比对话）', () => {
    mocks.interaction = localApproval();
    mocks.activeConversationId = SUB_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    expect(hasButton('跳转')).toBe(false);
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

  it('父任务自己也在本机（哨兵，理论上不会有：local_subagent 禁止嵌套）→ 同样不切会话', () => {
    mocks.tasks = {
      'sub-local': LOCAL_SUB_TASK,
      'task-parent': { ...PARENT_TASK, sessionId: LOCAL_SESSION_SENTINEL },
    };
    mocks.interaction = localApproval();
    mocks.activeConversationId = MAIN_CONV;
    mocks.activeSessionId = OTHER_SESSION;
    render();

    minimize();
    clickButton('跳转');

    expect(mocks.setActiveSession).not.toHaveBeenCalled();
    expect(mocks.switchConversation).toHaveBeenCalledWith(SUB_CONV);
  });

  it('空串 sessionId（重启恢复的交互）→ 不切会话（与旧行为一致）', () => {
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

/**
 * 回归（2026-10-06 线上爆炸）：2 题的 ask 答到第 2 题后，队列直接切到只有 1 题
 * 的下一个 ask。QuestionPanel 的 currentIndex/answers 是挂载时定下的 —— 交互
 * 切换若不重挂载（key），questions[currentIndex] 越界，渲染当场抛
 * TypeError，整棵树被顶层 ErrorBoundary 换成「出错了」。
 */
describe('提问交互的队列切换（不重挂载就崩的回归）', () => {
  const TWO_QUESTIONS: QuestionItem[] = [
    { header: '3001实例', question: '3001 走哪条路', multiple: false, options: [{ label: 'A', description: '选项说明' }, { label: 'B', description: '选项说明' }] },
    { header: '陈旧编排', question: '编排怎么处理', multiple: false, options: [{ label: 'C', description: '选项说明' }, { label: 'D', description: '选项说明' }] },
  ];
  const ONE_QUESTION: QuestionItem[] = [
    { header: '方案选择', question: '存档改不改', multiple: false, options: [{ label: 'E', description: '选项说明' }, { label: 'F', description: '选项说明' }] },
  ];

  function swapToNextAsk() {
    mocks.interaction = questionInteraction(ONE_QUESTION, {
      interactionId: 'int-q-next',
      question: { questionId: 'q-2', questions: ONE_QUESTION },
    });
    render();
  }

  it('答到第 2/2 题后切到 1 题的下一个 ask → 不崩，显示新交互的第一题', () => {
    mocks.interaction = questionInteraction(TWO_QUESTIONS);
    render();
    expect(container.textContent).toContain('3001实例');
    clickButton('下一题 →');
    expect(container.textContent).toContain('2/2');

    swapToNextAsk();

    expect(container.textContent).toContain('方案选择');
    expect(container.textContent).toContain('1/1');
  });

  it('切到下一个 ask 后答案不得串场（上一轮的选择不带入新面板）', () => {
    mocks.interaction = questionInteraction(TWO_QUESTIONS);
    render();
    clickOption('A');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('A');
    clickButton('下一题 →');

    swapToNextAsk();

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });
});
