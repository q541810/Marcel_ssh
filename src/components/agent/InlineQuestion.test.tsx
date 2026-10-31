// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActiveInteractionPayload, AgentMessage, QuestionItem } from '@/lib/types';
import { useInteractionStore } from '@/stores/interactionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useMessageJumpStore } from '@/stores/messageJumpStore';
import InlineQuestion from './InlineQuestion';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTIONS: QuestionItem[] = [
  {
    header: '方案', question: '走哪条', multiple: false, anchor: '方案对比',
    options: [{ label: 'A', description: '说明' }, { label: 'B', description: '说明' }],
  },
];

function interaction(over: Partial<ActiveInteractionPayload> = {}): ActiveInteractionPayload {
  return {
    type: 'interactionActive',
    interactionId: 'int-1',
    kind: 'question',
    taskId: 'task-1',
    sessionId: 'sess-1',
    conversationId: 'c1',
    conversationTitle: '标题',
    queueLength: 1,
    question: { questionId: 'q1', questions: QUESTIONS },
    ...over,
  };
}

const withText: AgentMessage[] = [
  {
    id: 'a1', role: 'assistant', content: '结论……', timestamp: 't',
    toolCalls: [{ id: 'q1', name: 'ask_user', arguments: {}, disposition: 'Allow' }],
  },
];

let container: HTMLDivElement;
let root: Root;
let scrollIntoView: ReturnType<typeof vi.fn>;
let seed = 0;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  useMessageJumpStore.setState({ request: null });
  useConversationStore.setState({ messages: {} });
  useInteractionStore.setState({ currentInteraction: null });
  seed += 1;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(mobile = false, conversationId = 'c1', over: Partial<ActiveInteractionPayload> = {}) {
  // questionId 每个用例唯一：自动定位按 questionId 只做一次，不能串用例
  const qid = `q-${seed}`;
  useInteractionStore.setState({
    currentInteraction: interaction({ question: { questionId: qid, questions: QUESTIONS }, ...over }),
  });
  useConversationStore.setState({
    messages: {
      c1: withText.map((m) => ({
        ...m, toolCalls: [{ id: qid, name: 'ask_user', arguments: {}, disposition: 'Allow' as const }],
      })),
    },
  });
  act(() => root.render(<InlineQuestion conversationId={conversationId} mobile={mobile} />));
  return qid;
}

describe('InlineQuestion（内联提问卡片）', () => {
  it('提问属于别的对话 → 不渲染', () => {
    mount(false, 'c-other');
    expect(container.textContent).toBe('');
  });

  it('提问属于本对话 → 渲染卡片（桌面 / 手机）且不抢焦点', () => {
    mount(false);
    expect(container.querySelector('[data-region="inline-question"]')).not.toBeNull();
    expect(container.textContent).toContain('走哪条');
    expect(document.activeElement).toBe(document.body);
    act(() => root.render(<div />));
    mount(true);
    expect(container.querySelector('[data-region="mobile-question"]')).not.toBeNull();
  });

  it('提问带 sourceSubagent：桌面卡片 / 手机卡片都显示来源行，点「查看它的上下文」不影响作答', () => {
    const src = { conversationId: 'sub-1', title: '查日志（子agent）', askToolCallId: 'ask-1' };
    const withSource = (qid: string) => ({ questionId: qid, questions: QUESTIONS, sourceSubagent: src });
    for (const mobile of [false, true]) {
      act(() => root.render(<div />));
      seed += 1;
      const qid = `q-${seed}`;
      mount(mobile, 'c1', { question: withSource(qid) });
      expect(container.querySelector('[data-testid="question-source"]')?.textContent).toContain('来自子 Agent「查日志」的问题');
      expect(container.textContent).toContain('查看它的上下文');
    }
  });

  it('普通提问没有来源行', () => {
    mount(false);
    expect(container.querySelector('[data-testid="question-source"]')).toBeNull();
  });

  it('不渲染审批', () => {
    mount(false, 'c1', { kind: 'approval', question: undefined });
    expect(container.textContent).toBe('');
  });

  it('新提问到达且有上文：自动发一次跳转请求（对准正文开头），按钮带 anchor 点名小标题', () => {
    const qid = mount(false);
    expect(useMessageJumpStore.getState().request).toMatchObject({
      conversationId: 'c1', toolCallId: qid, anchor: undefined,
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    useMessageJumpStore.setState({ request: null });
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('查看「方案对比」'),
    )!;
    act(() => btn.click());
    expect(useMessageJumpStore.getState().request).toMatchObject({ toolCallId: qid, anchor: '方案对比' });
  });

  it('没有上文：不出跳转按钮，改为滚到卡片', () => {
    const qid = mount(false);
    useMessageJumpStore.setState({ request: null });
    // 换成没有上文的新提问
    seed += 1;
    act(() => root.render(<div />));
    useConversationStore.setState({ messages: { c1: [] } });
    useInteractionStore.setState({
      currentInteraction: interaction({ interactionId: 'int-2', question: { questionId: `${qid}-b`, questions: QUESTIONS } }),
    });
    act(() => root.render(<InlineQuestion conversationId="c1" mobile={false} />));
    expect(container.textContent).not.toContain('查看');
    expect(useMessageJumpStore.getState().request).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('提交答案走 answerQuestion', () => {
    const answerQuestion = vi.fn(async () => {});
    useInteractionStore.setState({ answerQuestion });
    const qid = mount(false);
    const optionA = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('A'))!;
    act(() => optionA.click());
    const submit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '提交答案')!;
    act(() => submit.click());
    expect(answerQuestion).toHaveBeenCalledWith('task-1', qid, [{ selected: [], custom: 'A' }]);
  });
});
