// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { useInteractionStore } from '@/stores/interactionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { getToolView } from './toolViews';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ts = '2026-10-31T00:00:00Z';
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
  useInteractionStore.setState({ currentInteraction: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(message: AgentMessage) {
  const View = getToolView('ask_user', false)!;
  act(() => root.render(<View message={message} />));
}

describe('ask_user 已回答记录', () => {
  it('注册在工具视图表里，已回答显示一行摘要', () => {
    mount(record());
    expect(container.textContent).toContain('已回答：走 A');
  });

  it('转述子 agent 提问（source_subagent 是子对话 id）：已回答记录保留来源行，标题取子对话标题', () => {
    useConversationStore.setState({
      conversations: { 'sub-1': { id: 'sub-1', connectionId: 'c', title: '查日志（子agent）', createdAt: ts, updatedAt: ts } },
    });
    mount(record({}, '1. [方案] 走 A', { source_subagent: 'sub-1' }));
    expect(container.textContent).toContain('已回答：走 A');
    expect(container.querySelector('[data-testid="question-source"]')?.textContent).toContain('来自子 Agent「查日志」的问题');
  });

  it('被跳过的提问显示「已跳过提问」', () => {
    mount(record({}, '1. [方案] 用户未回答'));
    expect(container.textContent).toContain('已跳过提问');
  });

  it('待回答：提问在全局浮层里，对话里留一行灰色提示', () => {
    const pending = record({ isExecuting: true }, '');
    useInteractionStore.setState({
      currentInteraction: {
        type: 'interactionActive', interactionId: 'i', kind: 'question', taskId: 't', sessionId: 's',
        conversationId: 'c1', conversationTitle: '', queueLength: 1,
        question: { questionId: 'q1', questions: [] },
      },
    });
    mount(pending);
    expect(container.textContent).toContain('等待你的回答');
  });
});
