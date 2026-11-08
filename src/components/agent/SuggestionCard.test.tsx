// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSessionStore } from '@/stores/sessionStore';
import { getToolView } from './toolViews';
import { MessageJumpContext } from './messageJumpContext';

const mocks = vi.hoisted(() => ({
  startTask: vi.fn(async () => 'task-1'),
  occupying: { sessionId: 's1', session: { id: 's1', status: 'connected', connectionId: 'c1', configId: 'c1' } } as unknown,
}));

vi.mock('@/stores/sessionConversationBindingManager', () => ({
  sessionConversationBindingManager: { findOccupyingSession: () => mocks.occupying },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ts = '2026-11-05T00:00:00Z';
const ARGS = { question: '需要我把这次的修改推送到生产环境吗？', options: ['好的，帮我推送到生产环境', '不需要'] };
const toolMessage = (over: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 't1', role: 'tool', content: '', timestamp: ts,
  toolResult: { toolName: 'suggest_next', summary: '', result: '', success: true, blocked: false, toolCallId: 'call-1', arguments: ARGS },
  ...over,
});

let container: HTMLDivElement;
let root: Root;

function mount(message: AgentMessage = toolMessage()) {
  const View = getToolView('suggest_next', false)!;
  act(() => root.render(
    <MessageJumpContext.Provider value={{ conversationId: 'c1' }}>
      <View message={message} />
    </MessageJumpContext.Provider>,
  ));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.startTask.mockClear();
  mocks.occupying = { sessionId: 's1', session: { id: 's1', status: 'connected', connectionId: 'c1', configId: 'c1' } };
  useConversationStore.setState({ messages: { c1: [toolMessage()] } });
  useTaskStore.setState({ tasks: {}, compacting: {}, startTask: mocks.startTask } as never);
  useSessionStore.setState({ sessions: { s1: { id: 's1', status: 'connected' } } } as never);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const buttons = () => Array.from(container.querySelectorAll('button'));

describe('SuggestionCard（小建议卡片）', () => {
  it('shows the question and numbered options, small and without an input', () => {
    mount();
    const card = container.querySelector('[data-testid="suggestion-card"]')!;
    expect(card.textContent).toContain('需要我把这次的修改推送到生产环境吗？');
    expect(buttons().map((b) => b.textContent)).toEqual(['1.好的，帮我推送到生产环境', '2.不需要']);
    expect(container.querySelector('input, textarea')).toBeNull();
    expect(card.className).toContain('w-fit');
  });

  it('click sends the option as a message that replies to this very tool call', async () => {
    mount();
    await act(async () => buttons()[1].click());
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
    const [sessionId, text, connectionId, images, paths, options] = mocks.startTask.mock.calls[0] as unknown as [
      string, string, string, unknown[], unknown[], { conversationId: string; userInput: unknown },
    ];
    expect([sessionId, text, connectionId, images, paths]).toEqual(['s1', '不需要', 'c1', [], []]);
    expect(options.conversationId).toBe('c1');
    expect(options.userInput).toEqual({
      version: 1, text: '不需要', textAttachments: [],
      replyTo: { toolCallId: 'call-1', question: ARGS.question },
    });
  });

  describe('选项带目标模式（点了顺带切模式）', () => {
    const PLAN_ARGS = {
      question: '按这个计划执行吗？',
      options: [{ text: '按计划执行', mode: 'agent' }, { text: '全自动执行', mode: 'auto' }, '我再改改'],
    };
    const planMessage = () => toolMessage({
      toolResult: { ...toolMessage().toolResult!, arguments: PLAN_ARGS },
    });
    const sentOptions = () => (mocks.startTask.mock.calls[0] as unknown as [
      string, string, string, unknown[], unknown[], { userInput: { replyTo: unknown } },
    ])[5];

    beforeEach(() => useTaskStore.setState({ mode: 'plan' } as never));

    it('labels only the options that would actually change the mode', () => {
      mount(planMessage());
      expect(buttons().map((b) => b.textContent)).toEqual([
        '1.按计划执行→ Agent', '2.全自动执行→ Auto', '3.我再改改',
      ]);
      // 目标就是当前模式：不标，点了也不切
      useTaskStore.setState({ mode: 'agent' } as never);
      act(() => root.render(<div />));
      mount(planMessage());
      expect(buttons()[0].textContent).toBe('1.按计划执行');
    });

    it('switches the mode first, then sends, and tells the model about the switch', async () => {
      const order: string[] = [];
      useTaskStore.setState({
        startTask: vi.fn(async () => { order.push(`send@${useTaskStore.getState().mode}`); return 't'; }),
      } as never);
      mount(planMessage());
      await act(async () => buttons()[0].click());
      expect(useTaskStore.getState().mode).toBe('agent');
      expect(order).toEqual(['send@agent']);
    });

    it('records the switch on the reply so the bubble and the model input agree', async () => {
      mount(planMessage());
      await act(async () => buttons()[1].click());
      expect(sentOptions().userInput.replyTo).toEqual({
        toolCallId: 'call-1', question: PLAN_ARGS.question, switchedTo: 'auto',
      });
    });

    it('puts the mode back when sending fails', async () => {
      mocks.startTask.mockRejectedValueOnce(new Error('boom'));
      mount(planMessage());
      await act(async () => buttons()[0].click());
      expect(useTaskStore.getState().mode).toBe('plan');
      expect(container.textContent).toContain('没发出去');
    });

    it('an option without a mode never touches the mode', async () => {
      mount(planMessage());
      await act(async () => buttons()[2].click());
      expect(useTaskStore.getState().mode).toBe('plan');
      expect(sentOptions().userInput.replyTo).toEqual({ toolCallId: 'call-1', question: PLAN_ARGS.question });
    });
  });

  it('does not touch focus (the user can keep typing)', () => {
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    mount();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('disappears once the user has said something after it', () => {
    useConversationStore.setState({
      messages: { c1: [toolMessage(), { id: 'u2', role: 'user', content: '先别推', timestamp: ts }] },
    });
    mount();
    expect(container.textContent).toBe('');
  });

  it('is disabled while the agent is still running, and when the machine is disconnected', () => {
    useTaskStore.setState({
      tasks: { x: { id: 'x', conversationId: 'c1', sessionId: 's1', status: 'executing' } },
    } as never);
    mount();
    expect(buttons().every((b) => b.disabled)).toBe(true);

    useTaskStore.setState({ tasks: {} } as never);
    useSessionStore.setState({ sessions: { s1: { id: 's1', status: 'disconnected' } } } as never);
    act(() => root.render(<div />));
    mount();
    expect(buttons().every((b) => b.disabled)).toBe(true);
  });

  it('renders nothing for a failed call or malformed arguments', () => {
    mount(toolMessage({ toolResult: { ...toolMessage().toolResult!, success: false } }));
    expect(container.textContent).toBe('');
    act(() => root.render(<div />));
    mount(toolMessage({ toolResult: { ...toolMessage().toolResult!, arguments: { question: 'q' } } }));
    expect(container.textContent).toBe('');
  });

  it('shows a short error when sending fails and lets the user retry', async () => {
    mocks.startTask.mockRejectedValueOnce(new Error('boom'));
    mount();
    await act(async () => buttons()[0].click());
    expect(container.textContent).toContain('没发出去');
    expect(buttons()[0].disabled).toBe(false);
  });
});
