// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { useMessageJumpStore } from '@/stores/messageJumpStore';
import { useInteractionStore } from '@/stores/interactionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useVisibleTranscriptStore } from '@/stores/visibleTranscriptStore';
import { getToolView } from './toolViews';
import { MessageJumpContext } from './messageJumpContext';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ts = '2026-10-31T00:00:00Z';
const text: AgentMessage = {
  id: 'a1', role: 'assistant', content: '结论', timestamp: ts,
  toolCalls: [{ id: 'q1', name: 'ask_user', arguments: {}, disposition: 'Allow' }],
};
function record(over: Partial<AgentMessage> = {}, result = '1. [方案] 走 A', args: Record<string, unknown> = {}): AgentMessage {
  return {
    id: 't1', role: 'tool', content: '', timestamp: ts,
    toolResult: {
      toolName: 'ask_user', summary: '用户已回答', result, success: true, blocked: false,
      toolCallId: 'q1', arguments: args,
    },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useMessageJumpStore.setState({ request: null });
  useInteractionStore.setState({ currentInteraction: null });
  useVisibleTranscriptStore.setState({ byInstance: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(message: AgentMessage, messages: AgentMessage[] | null) {
  const View = getToolView('ask_user', false)!;
  const ref = createRef<readonly AgentMessage[]>() as unknown as { current: readonly AgentMessage[] };
  ref.current = messages ?? [];
  act(() => root.render(
    <MessageJumpContext.Provider value={messages ? { conversationId: 'c1', messagesRef: ref } : null}>
      <View message={message} />
    </MessageJumpContext.Provider>,
  ));
}

describe('ask_user 已回答记录', () => {
  it('注册在工具视图表里，已回答显示一行摘要', () => {
    mount(record(), [text, record()]);
    expect(container.textContent).toContain('已回答：走 A');
  });

  it('有上文：每个带 anchor 的问题一个跳转按钮（anchor 归一化），点击发出请求', () => {
    const args = { questions: [{ anchor: '**方案对比**：' }, { anchor: '风险' }, { question: 'x' }] };
    mount(record({}, '1. [a] A', args), [text, record()]);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['查看「方案对比」', '查看「风险」']);
    act(() => buttons[1].click());
    expect(useMessageJumpStore.getState().request).toMatchObject({
      conversationId: 'c1', toolCallId: 'q1', anchor: '风险',
    });
  });

  it('转述子 agent 提问（source_subagent 是子对话 id）：已回答记录保留来源行，标题取子对话标题', () => {
    useConversationStore.setState({
      conversations: { 'sub-1': { id: 'sub-1', connectionId: 'c', title: '查日志（子agent）', createdAt: ts, updatedAt: ts } },
    });
    mount(record({}, '1. [方案] 走 A', { source_subagent: 'sub-1' }), [text, record()]);
    expect(container.textContent).toContain('已回答：走 A');
    expect(container.querySelector('[data-testid="question-source"]')?.textContent).toContain('来自子 Agent「查日志」的问题');
  });

  it('没有 anchor：整条记录一个「查看上文」', () => {
    mount(record(), [text, record()]);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('查看上文');
  });

  it('没有上文 / 不在可跳转的对话流里（历史预览）→ 不出按钮', () => {
    mount(record(), [record()]);
    expect(container.querySelector('button')).toBeNull();
    act(() => root.render(<div />));
    mount(record(), null);
    expect(container.querySelector('button')).toBeNull();
  });

  it('被跳过的提问显示「已跳过提问」', () => {
    mount(record({}, '1. [方案] 用户未回答'), [text]);
    expect(container.textContent).toContain('已跳过提问');
  });

  it('待回答：内联卡片正显示时不占位；提问在别处时留一行提示', () => {
    const pending = record({ isExecuting: true }, '');
    useInteractionStore.setState({
      currentInteraction: {
        type: 'interactionActive', interactionId: 'i', kind: 'question', taskId: 't', sessionId: 's',
        conversationId: 'c1', conversationTitle: '', queueLength: 1,
        question: { questionId: 'q1', questions: [] },
      },
    });
    useVisibleTranscriptStore.getState().register('x', 'c1');
    mount(pending, [text, pending]);
    expect(container.textContent).toBe('');

    useVisibleTranscriptStore.setState({ byInstance: {} });
    act(() => root.render(<div />));
    mount(pending, [text, pending]);
    expect(container.textContent).toContain('等待你的回答');
  });
});
