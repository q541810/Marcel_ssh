// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentTranscript from './AgentTranscript';
import { useConversationStore } from '@/stores/conversationStore';

vi.mock('./AgentMessageList', () => ({
  default: ({ messages }: { messages: { content: string }[] }) => <div>{messages.map((m) => m.content).join('')}</div>,
}));
let root: Root;
let host: HTMLDivElement;
let resize: ResizeObserverCallback;
let frames: Map<number, FrameRequestCallback>;
const justSent = createRef<boolean>() as { current: boolean };
const props = {
  canInteract: true, conversationId: 'a', rollbackDisabled: false,
  userJustSentRef: justSent, onRollback: vi.fn(), onCopy: vi.fn(), emptyState: 'empty',
};
async function render(visible = true, conversationId = 'a') {
  await act(async () => root.render(<AgentTranscript {...props} visible={visible} conversationId={conversationId} />));
}
function messages(id: string, text: string) {
  useConversationStore.getState().updateConversationMessages(id, () => [
    { id: 'message', role: 'assistant', content: text, timestamp: '' },
  ]);
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  messages('a', 'first');
  justSent.current = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function geometry() {
  const node = host.querySelector('.overflow-y-auto') as HTMLDivElement;
  Object.defineProperty(node, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: 200 });
  return node;
}
async function userScroll(node: HTMLElement, top: number) {
  await act(async () => {
    node.dispatchEvent(new Event('wheel'));
    node.scrollTop = top;
    node.dispatchEvent(new Event('scroll'));
  });
}
async function resizeContent() {
  await act(async () => {
    resize([], {} as ResizeObserver);
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((cb) => cb(0));
  });
}
describe('transcript follow ownership', () => {
  it('follows large stream/async layout growth, but leaves a reader alone', async () => {
    await render();
    const node = geometry();
    await act(async () => messages('a', 'grown'));
    expect(node.scrollTop).toBe(1000);
    await userScroll(node, 20);
    await act(async () => messages('a', 'more'));
    await resizeContent();
    expect(node.scrollTop).toBe(20);
    expect(host.querySelector('[aria-label="回到底部"]')).not.toBeNull();
    await userScroll(node, 800);
    await resizeContent();
    expect(node.scrollTop).toBe(1000);
  });
  it('preserves a reader while hidden and ignores geometry resets from hiding', async () => {
    await render();
    const node = geometry();
    await userScroll(node, 20);
    await render(false);
    await act(async () => messages('a', 'hidden update'));
    expect(host.textContent).not.toContain('hidden update');
    await render(true);
    expect(host.textContent).toContain('hidden update');
    expect(node.scrollTop).toBe(20);
    await userScroll(node, 800);
    await render(false);
    await userScroll(node, 0);
    await render(true);
    expect(node.scrollTop).toBe(1000);
  });
  it('pins on conversation changes and explicit sends, without clearing unloaded data', async () => {
    await render();
    const node = geometry();
    await userScroll(node, 20);
    justSent.current = true;
    await act(async () => messages('a', 'sent'));
    expect(node.scrollTop).toBe(1000);
    expect(justSent.current).toBe(false);
    await userScroll(node, 20);
    await act(async () => messages('b', 'other'));
    await render(true, 'b');
    expect(node.scrollTop).toBe(1000);
    const before = useConversationStore.getState();
    await render(true, 'unloaded');
    expect(host.textContent).toBe('empty');
    expect(useConversationStore.getState()).toBe(before);
  });
});
