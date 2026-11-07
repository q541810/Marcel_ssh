// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, SubagentQuestionSource } from '@/lib/types';
import { deriveSubagentMessages } from '@/lib/subagentThread';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageJumpStore } from '@/stores/messageJumpStore';
import { getToolView } from './toolViews';
import SubagentThreadCard from './SubagentThreadCard';
import SubagentAwaitingNotice from './SubagentAwaitingNotice';
import { QuestionSourceLine } from './QuestionSourceLine';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ts = '2026-11-01T00:00:00Z';
const SUB = 'sub-1';

const openConversation = vi.fn(async () => {});
vi.mock('@/stores/sessionConversationBindingManager', () => ({
  sessionConversationBindingManager: { openConversation: (...a: unknown[]) => (openConversation as (...x: unknown[]) => Promise<void>)(...a) },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  openConversation.mockClear();
  useMessageJumpStore.setState({ request: null });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const user: AgentMessage = { id: 'u', role: 'user', content: 'go', timestamp: ts };
function sub(id: string, args: Record<string, unknown>, metadata?: Record<string, unknown>, result = '结果'): AgentMessage {
  return {
    id, role: 'tool', content: '', timestamp: ts,
    toolResult: { toolName: 'subagent', summary: '', result, success: true, blocked: false, toolCallId: `${id}-c`, arguments: args, metadata },
  };
}
const asked = sub('d1', { description: '查日志', prompt: 'p' }, {
  kind: 'subagentAsk', subConversationId: SUB, askToolCallId: 'ask-1', question: '用哪个目录？', context: '日志在两处',
});
const answered = sub('d2', { continue_id: SUB, prompt: '用 /var/log' }, { subTaskId: 't', subConversationId: SUB, status: 'completed' }, '最终报告');

function mountThread(msgs: AgentMessage[], tailActive = false) {
  const anchor = deriveSubagentMessages(msgs, { tailActive }).messages.find((m) => m.subagentThread)!;
  act(() => root.render(<SubagentThreadCard message={anchor} thread={anchor.subagentThread!} />));
}

/** 点开折叠行（卡片的标题行是第一个按钮）。 */
function expand() {
  act(() => { container.querySelector('button')!.click(); });
}

describe('时间线卡', () => {
  it('默认折叠成一行：和普通子 agent 工具行同一副骨架，只多一个「问过 N 次」小标记', () => {
    mountThread([user, asked, answered]);
    const text = container.textContent ?? '';
    expect(text).toContain('查日志');
    expect(text).toContain('问过 1 次');
    // 过程细节都收着：问、答、结果、查看入口都不在
    expect(container.querySelector('[data-testid="thread-ask"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-answer"]')).toBeNull();
    expect(text).not.toContain('用哪个目录？');
    expect(text).not.toContain('查看完整调研过程');
    // 不带彩色：没有绿徽标 / 蓝徽标 / 气泡底
    expect(container.innerHTML).not.toMatch(/emerald|bg-sky-500\/10|bg-indigo-500\/10/);
    // 完成了就什么状态字都不说（和普通工具行一个口径）
    expect(text).not.toContain('已完成');
  });

  it('展开：缩进的纯文字时间线「派活 / 问 / 答 / 已完成」，没有气泡', () => {
    mountThread([user, asked, answered]);
    expand();
    const text = container.textContent ?? '';
    expect(text).toContain('派活：');
    expect(text).toContain('查日志');
    expect(container.querySelector('[data-testid="thread-ask"]')?.textContent).toContain('问：用哪个目录？');
    expect(container.querySelector('[data-testid="thread-answer"]')?.textContent).toContain('答：用 /var/log');
    expect(text).toContain('已完成');
    expect(text).toContain('查看完整调研过程');
    expect(container.innerHTML).not.toMatch(/rounded-xl|emerald|bg-sky-500\/10|bg-indigo-500\/10/);
    // 背景信息默认收起在 details 里
    expect(container.querySelector('[data-testid="thread-ask"] details')?.hasAttribute('open')).toBe(false);
  });

  it('主 Agent 这轮还在跑、没回答 → 折叠行末尾一小段灰字「等待回答」', () => {
    mountThread([user, asked], true);
    expect(container.textContent).toContain('等待回答');
    expect(container.textContent).not.toContain('未回答');
    const badge = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '等待回答')!;
    expect(badge.className).toContain('text-fg-tertiary');
    // 折叠时不出问答正文
    expect(container.querySelector('[data-testid="thread-ask"]')).toBeNull();
    // 展开后问题下面也是灰字「等待回答」
    expand();
    expect(container.querySelector('[data-testid="thread-ask"]')?.textContent).toContain('等待回答');
  });

  it('主 Agent 这轮结束仍没回答 → 「未回答」，不显示运行中', () => {
    mountThread([user, asked, { id: 'end', role: 'assistant', content: '先这样', timestamp: ts }], false);
    expect(container.textContent).toContain('未回答');
    expect(container.textContent).not.toContain('继续中');
    expect(container.textContent).not.toContain('等待回答');
  });

  it('续派在执行中 → 转圈 + 实时过程入口不用展开就在；展开后「继续中…」与已执行步骤数', () => {
    useConversationStore.setState({
      messages: {
        [SUB]: [
          { id: 's1', role: 'tool', content: '', timestamp: ts, toolResult: { toolName: 'bash', summary: '', result: '', success: true, blocked: false } },
          { id: 's2', role: 'tool', content: '', timestamp: ts, toolResult: { toolName: 'ask_parent', summary: '', result: '', success: true, blocked: false } },
        ],
      },
    });
    mountThread([user, asked, { ...answered, isExecuting: true, toolResult: { ...answered.toolResult!, metadata: undefined } }], true);
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain('查看实时调研过程');
  });

  it('失败 / 中断才有颜色字（和普通工具行一致），完成不说话', () => {
    const failed = sub('d2', { continue_id: SUB, prompt: 'p' }, { subTaskId: 't', subConversationId: SUB, status: 'failed' }, '出错');
    failed.toolResult!.success = false;
    mountThread([user, asked, failed]);
    const badge = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '失败');
    expect(badge?.className).toContain('text-red-400');
  });

  it('展开后点「查看完整调研过程」打开子对话', async () => {
    mountThread([user, asked, answered]);
    expand();
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('查看完整调研过程'))!;
    await act(async () => { btn.click(); });
    expect(openConversation).toHaveBeenCalledWith(SUB);
  });
});

describe('ask_parent 气泡', () => {
  const View = getToolView('ask_parent', false)!;
  function ask(over: Partial<AgentMessage> = {}, result = '', success = true): AgentMessage {
    return {
      id: 'k', role: 'tool', content: '', timestamp: ts,
      toolResult: {
        toolName: 'ask_parent', summary: '', result, success, blocked: false, toolCallId: 'ask-1',
        arguments: { question: '路径是？', context: '背景说明' },
      },
      ...over,
    };
  }

  it('注册在工具视图表里（不是通用工具卡）', () => {
    expect(View).toBeTruthy();
  });

  it('是一行普通的工具记录（中性、没有气泡），默认只给问题摘要', () => {
    act(() => root.render(<View message={ask({}, '用 /var/log')} />));
    expect(container.textContent).toContain('路径是？');
    expect(container.textContent).not.toContain('用 /var/log');
    expect(container.innerHTML).not.toMatch(/rounded-2xl|bg-sky-500\/10|bg-indigo-500\/10/);
  });

  it('等待中：问题直接可见 +「等待主 Agent 回答…」，背景信息默认收起', () => {
    act(() => root.render(<View message={ask({ isExecuting: true })} />));
    expect(container.textContent).toContain('问：路径是？');
    expect(container.querySelector('[data-testid="ask-parent-waiting"]')).not.toBeNull();
    expect(container.textContent).not.toContain('背景说明');
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('背景信息'))!;
    act(() => toggle.click());
    expect(container.textContent).toContain('背景说明');
  });

  it('已回答：点开行，展开成「问：… 答：…」', () => {
    act(() => root.render(<View message={ask({}, '用 /var/log')} />));
    act(() => { container.querySelector('button')!.click(); });
    expect(container.textContent).toContain('答：用 /var/log');
    expect(container.querySelector('[data-testid="ask-parent-waiting"]')).toBeNull();
  });

  it('参数还在撰写时不占位', () => {
    act(() => root.render(<View message={ask({ isExecuting: true, isComposing: true })} />));
    expect(container.textContent).toBe('');
  });
});

describe('子对话底部「正在等待主 Agent 回答」', () => {
  const pendingMsgs: AgentMessage[] = [
    user,
    {
      id: 'k', role: 'tool', content: '', timestamp: ts, isExecuting: true,
      toolResult: { toolName: 'ask_parent', summary: '', result: '', success: true, blocked: false, toolCallId: 'ask-1', arguments: { question: 'Q' } },
    },
  ];

  it('子对话有未回答的提问时出现，「回到主对话」打开父对话并提交跳到时间线卡的请求', async () => {
    useConversationStore.setState({
      conversations: { [SUB]: { id: SUB, connectionId: 'c', title: 't', createdAt: ts, updatedAt: ts, parentConversationId: 'main' } },
    });
    act(() => root.render(<SubagentAwaitingNotice conversationId={SUB} messages={pendingMsgs} />));
    expect(container.textContent).toContain('正在等待主 Agent 回答');
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '回到主对话')!;
    await act(async () => { btn.click(); });
    expect(openConversation).toHaveBeenCalledWith('main');
    expect(useMessageJumpStore.getState().request).toMatchObject({ conversationId: 'main', toolCallId: SUB, kind: 'thread' });
  });

  it('不是子对话 / 没有未回答提问时不出现', () => {
    useConversationStore.setState({ conversations: { [SUB]: { id: SUB, connectionId: 'c', title: 't', createdAt: ts, updatedAt: ts } } });
    act(() => root.render(<SubagentAwaitingNotice conversationId={SUB} messages={pendingMsgs} />));
    expect(container.textContent).toBe('');
  });
});

describe('ask_user 来源行', () => {
  const source: SubagentQuestionSource = { conversationId: SUB, title: '查日志（子agent）', askToolCallId: 'ask-1' };

  it('显示「来自子 Agent「…」的问题」，去掉登记时的（子agent）后缀', () => {
    act(() => root.render(<QuestionSourceLine source={source} />));
    expect(container.textContent).toContain('来自子 Agent「查日志」的问题');
    expect(container.textContent).toContain('查看它的上下文');
    // 一行安静的灰字，不是彩色标签
    expect(container.innerHTML).not.toMatch(/sky-/);
  });

  it('点「查看它的上下文」：打开子对话并提交跳到 ask_parent 调用的请求', async () => {
    act(() => root.render(<QuestionSourceLine source={source} />));
    await act(async () => { container.querySelector('button')!.click(); });
    expect(openConversation).toHaveBeenCalledWith(SUB);
    expect(useMessageJumpStore.getState().request).toMatchObject({ conversationId: SUB, toolCallId: 'ask-1', kind: 'tool' });
  });

  it('手机提醒条模式（interactive=false）只有文字，没有嵌套按钮', () => {
    act(() => root.render(<QuestionSourceLine source={source} interactive={false} />));
    expect(container.querySelector('button')).toBeNull();
  });
});
