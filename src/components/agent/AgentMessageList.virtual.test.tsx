// @vitest-environment jsdom
import { act, createRef, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useTurnFoldStore } from '@/stores/turnFoldStore';
import { setForcedPlatform } from '@/platform';
import AgentMessageList, { type AgentMessageListHandle } from './AgentMessageList';
import AgentTranscript from './AgentTranscript';

vi.mock('./AgentMessage', () => ({
  default: ({ message }: { message: AgentMessage }) => <p>{message.content}</p>,
}));
vi.mock('./HtmlVisualization', () => ({
  default: () => <iframe title="retained-chart" />,
}));
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { foldCompletedTurns: false } }),
}));

let host: HTMLDivElement;
let viewport: HTMLDivElement;
let root: Root;
let data: AgentMessage[];
let originalScrollTo: typeof HTMLElement.prototype.scrollTo;
let originalScrollBy: typeof HTMLElement.prototype.scrollBy;
const handle = createRef<AgentMessageListHandle>();
let itemHeight = 120;
let heights: Map<string, number>;
class ResizeMock {
  static all = new Set<ResizeMock>();
  elements = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { ResizeMock.all.add(this); }
  observe = (element: Element) => { this.elements.add(element); };
  unobserve = (element: Element) => { this.elements.delete(element); };
  disconnect = () => { this.elements.clear(); ResizeMock.all.delete(this); };
}
const collectionHeight = (node: HTMLElement): number | undefined => {
  const collection = node.matches('[data-virtual-row-collection]') ? node
    : node.querySelector<HTMLElement>(':scope > [data-virtual-row-collection]');
  if (!collection) return;
  return Array.from(collection.children).reduce((sum, child) => sum
    + (heights.get(child.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '') ?? itemHeight), 0);
};
const dimensions = (node: HTMLElement): { width: number; height: number } => ({
  width: 600,
  height: node === viewport ? 600
    : collectionHeight(node) !== undefined ? collectionHeight(node)!
    : node.querySelector(':scope > [data-virtual-row-hidden="true"]') ? 0
    : node.querySelector(':scope > [data-virtual-row-key]')
      ? heights.get(node.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '') ?? itemHeight
    : Number.parseFloat(node.style.height) || 0,
});
function fixture(count: number): AgentMessage[] {
  // One large unfinished turn must itself be virtualized, not a single huge row.
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`, role: i === 0 ? 'user' : 'assistant', content: `text-${i}`, timestamp: '',
  }));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  heights = new Map();
  itemHeight = 120;
  vi.stubGlobal('ResizeObserver', ResizeMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.isConnected ? this.parentElement : null;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return dimensions(this).height;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this !== viewport) return dimensions(this).height;
    return Number.parseFloat(this.querySelector<HTMLElement>('[style*="contain: size"]')?.style.height ?? '') || 600;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const { width, height } = dimensions(this);
    const top = this === viewport ? 0 : (Number.parseFloat(this.style.top) || 0) - viewport.scrollTop;
    return { x: 0, y: top, top, left: 0, width, height, bottom: top + height, right: width, toJSON() {} };
  });
  const scrollOffsets = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return scrollOffsets.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (next === (scrollOffsets.get(this) ?? 0)) return;
    scrollOffsets.set(this, next);
    queueMicrotask(() => { if (this.isConnected) this.dispatchEvent(new Event('scroll')); });
  });
  originalScrollTo = HTMLElement.prototype.scrollTo;
  originalScrollBy = HTMLElement.prototype.scrollBy;
  HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number = {}, y?: number) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight,
      typeof options === 'number' ? y ?? 0 : options.top ?? this.scrollTop));
  };
  HTMLElement.prototype.scrollBy = function (options: ScrollToOptions | number = {}, y?: number) {
    this.scrollTo({ top: this.scrollTop + (typeof options === 'number' ? y ?? 0 : options.top ?? 0) });
  };
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useTurnFoldStore.setState({ expanded: {} });
  host = document.createElement('div');
  viewport = document.createElement('div');
  viewport.className = 'overflow-y-auto';
  host.append(viewport);
  document.body.append(host);
  root = createRoot(viewport);
  data = fixture(10000);
});
afterEach(async () => {
  await act(async () => root.unmount());
  setForcedPlatform(null);
  host.remove();
  vi.restoreAllMocks();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  HTMLElement.prototype.scrollBy = originalScrollBy;
  vi.unstubAllGlobals();
  ResizeMock.all.clear();
});
async function settle() {
  for (let pass = 0; pass < 8; pass++) {
    await act(async () => {
      for (const observer of [...ResizeMock.all]) {
        observer.callback([...observer.elements].filter((node) => node.isConnected).map((target) => ({
          target, contentRect: (target as HTMLElement).getBoundingClientRect(),
        })) as ResizeObserverEntry[], observer as unknown as ResizeObserver);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function render(extra: Partial<Parameters<typeof AgentMessageList>[0]> = {}) {
  await act(async () => root.render(
    <AgentMessageList messages={data} conversationId="test" listRef={handle} {...extra} />,
  ));
  await settle();
}
async function scroll(top: number) {
  await act(async () => {
    viewport.dispatchEvent(new Event('wheel'));
    viewport.scrollTo({ top });
  });
  await settle();
}
function renderedIds() {
  return [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].map((el) => el.dataset.messageId);
}

describe('real virtualizer integration', () => {
  it('bounds DOM for 10,000 rows and navigates to offscreen search matches and the bottom', async () => {
    await render();
    expect(renderedIds()).toContain('m9999');
    expect(renderedIds().length).toBeLessThan(40);
    await render({ highlightMessageId: 'm5000' });
    expect(renderedIds()).toContain('m5000');
    expect(renderedIds()).not.toContain('m9999');
    expect(renderedIds().length).toBeLessThan(40);
    await act(async () => handle.current!.scrollToBottom());
    await settle();
    expect(renderedIds()).toContain('m9999');
  });

  it('restores tool expansion after a real virtual unmount without keeping all tools mounted', async () => {
    data[5000] = {
      ...data[5000], role: 'tool', content: '',
      toolResult: { toolName: 'bash', summary: 'test-command', result: 'PRESERVED_OUTPUT', success: true, blocked: false },
    };
    await render({ highlightMessageId: 'm5000' });
    const row = viewport.querySelector('[data-message-id="m5000"]')!;
    const button = row.querySelector('button')!;
    await act(async () => button.click());
    expect(row.textContent).toContain('PRESERVED_OUTPUT');
    // Blur the clicked control, otherwise the accessibility keep-mounted policy retains it.
    await act(async () => {
      viewport.tabIndex = -1;
      viewport.focus();
      handle.current!.scrollToBottom();
    });
    await settle();
    expect(renderedIds()).not.toContain('m5000');
    await render({ highlightMessageId: 'm5001' });
    await render({ highlightMessageId: 'm5000' });
    expect(viewport.querySelector('[data-message-id="m5000"]')?.textContent).toContain('PRESERVED_OUTPUT');
  });

  it('retains only visited dedicated views, preserving the same iframe instance', async () => {
    for (const index of [4000, 5000]) {
      data[index] = { ...data[index], role: 'tool', toolResult: {
        toolName: 'render_html', result: '', summary: '', success: true, blocked: false,
      } };
    }
    await render({ highlightMessageId: 'm5000' });
    const frame = viewport.querySelector('iframe')!;
    expect(frame).not.toBeNull();
    expect(viewport.querySelectorAll('iframe')).toHaveLength(1);
    await act(async () => handle.current!.scrollToBottom());
    await settle();
    expect(viewport.querySelector('iframe')).toBe(frame);
    expect(renderedIds()).not.toContain('m4000');
    expect(renderedIds().length).toBeLessThan(40);
  });

  it.each([
    { mobile: false, transcript: false },
    { mobile: true, transcript: false },
    { mobile: false, transcript: true },
    { mobile: true, transcript: true },
  ])('cold multi-view mount stays stable (mobile=$mobile, transcript=$transcript)', async ({ mobile, transcript }) => {
    setForcedPlatform(mobile ? 'mobile' : 'desktop');
    data = fixture(40);
    itemHeight = 24;
    // All four are in the virtualizer's initial SSR window, before height measurement.
    for (const index of [1, 3, 5, 7]) {
      data[index] = { ...data[index], role: 'tool', toolResult: {
        toolName: 'render_html', result: '', summary: `chart-${index}`, success: true, blocked: false,
      } };
    }

    const commits = vi.fn();
    const onCopy = vi.fn();
    const onRollback = vi.fn();
    const userJustSentRef = { current: false };
    const content = (rollbackDisabled = false) => <Profiler id="list" onRender={commits}>
      {transcript ? <AgentTranscript canInteract conversationId="test" mobile={mobile}
        rollbackDisabled={rollbackDisabled} onCopy={onCopy} onRollback={onRollback}
        userJustSentRef={userJustSentRef} emptyState={null} />
        : <AgentMessageList messages={data} conversationId="test" listRef={handle}
          rollbackDisabled={rollbackDisabled} />}
    </Profiler>;
    useConversationStore.setState({ messages: { test: data }, activeConversationId: 'test' });
    await act(async () => root.render(content()));
    if (transcript) viewport = host.querySelector<HTMLDivElement>('.overflow-y-auto .overflow-y-auto')!;
    await settle();

    expect(renderedIds().length).toBeGreaterThan(0);
    expect(viewport.querySelectorAll('iframe')).toHaveLength(mobile ? 0 : 4);
    const views = [1, 3, 5, 7].map((index) => viewport.querySelector(`[data-message-id="m${index}"]`));
    for (const view of views) {
      expect(view).not.toBeNull();
      if (mobile) expect(view!.textContent).toContain('交互可视化仅支持桌面端');
    }
    // A parent update must not reattach view refs and schedule another commit.
    commits.mockClear();
    await act(async () => root.render(content(true)));
    expect(commits).toHaveBeenCalled();
    expect(commits.mock.calls.every((call) => call[1] === 'update')).toBe(true);
    expect(useConversationStore.getState().messages.test).toBe(data);

    const frames = [...viewport.querySelectorAll('iframe')];
    data = [...data, ...fixture(400).slice(40)];
    data[100] = { ...data[100], role: 'tool', toolResult: {
      toolName: 'render_html', result: '', summary: 'unvisited', success: true, blocked: false,
    } };
    await act(async () => {
      useConversationStore.setState({ messages: { test: data } });
      root.render(content(true));
    });
    await settle();
    await scroll(viewport.scrollHeight);
    expect(renderedIds()).toContain('m399');
    expect(renderedIds()).not.toContain('m100');
    expect(renderedIds()).not.toContain('m2');
    for (const view of views) expect(view!.isConnected).toBe(true);
    expect([...viewport.querySelectorAll('iframe')]).toEqual(frames);
  });

  it('preserves the visible anchor on prepend and does not follow new output while reading up', async () => {
    await render({ highlightMessageId: 'm5000' });
    const before = viewport.scrollTop;
    data = [...fixture(100).map((m) => ({ ...m, id: `old-${m.id}` })), ...data];
    await render({ highlightMessageId: 'm5000' });
    expect(renderedIds()).toContain('m5000');
    expect(viewport.scrollTop).toBeGreaterThan(before);
    const afterPrepend = viewport.scrollTop;
    data = [...data, { id: 'new', role: 'assistant', content: 'new output', timestamp: '' }];
    await render({ highlightMessageId: 'm5000' });
    expect(viewport.scrollTop).toBe(afterPrepend);
    expect(renderedIds()).toContain('m5000');
  });

  it('does not load archived pages for a read-only list belonging to another data snapshot', async () => {
    const load = vi.fn();
    useConversationStore.setState({
      activeConversationId: 'other', hasEarlierMessages: { other: true, test: true },
      messages: { other: fixture(2) }, loadEarlierHistory: load,
    });
    await render({ highlightMessageId: 'm0' });
    await scroll(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps expanded turn and tool members in one natural-flow virtual item', async () => {
    data = [
      { ...fixture(1)[0], turnState: 'completed' },
      ...Array.from({ length: 40 }, (_, i): AgentMessage => ({
        id: `tool-${i}`, role: 'tool', content: '', timestamp: '',
        toolResult: { toolName: 'read_file', result: 'read', summary: 'read', success: true, blocked: false },
      })),
      { id: 'answer', role: 'assistant', content: 'done', timestamp: '' },
    ];
    await render({ foldTurns: true });
    const turn = viewport.querySelector<HTMLButtonElement>('[data-turn-fold-control] button')!;
    await act(async () => turn.click());
    await settle();
    const group = viewport.querySelector<HTMLButtonElement>('[data-virtual-row-key^="group:"] button')!;
    expect(group).not.toBeNull();
    await act(async () => group.click());
    await settle();
    expect(renderedIds().some((id) => id?.startsWith('tool-'))).toBe(true);
    expect(renderedIds().filter((id) => id?.startsWith('tool-'))).toHaveLength(40);
    const collections = [...viewport.querySelectorAll('[data-message-id^="tool-"]')].map((node) => node.closest('[data-virtual-row-collection]'));
    expect(new Set(collections).size).toBe(1);
  });

  it('keeps the same natural-flow tool nodes after reveal without remounting them', async () => {
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const pending: Animation[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(() => {
        const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
        pending.push(animation);
        return animation;
      }),
    });
    try {
      data = [fixture(1)[0], ...Array.from({ length: 40 }, (_, i): AgentMessage => ({
        id: `tool-${i}`, role: 'tool', content: '', timestamp: '',
        toolResult: { toolName: 'bash', result: 'output', summary: `command-${i}`, success: true, blocked: false },
      })), { id: 'answer', role: 'assistant', content: 'done', timestamp: '' }];
      await render();
      const group = viewport.querySelector<HTMLButtonElement>('[data-virtual-row-key^="group:"] button')!;
      expect(group).not.toBeNull();
      await act(async () => group.click());
      // Flush both entry frames and ResizeObserver measurements while WAAPI remains pending.
      await settle();
      expect(pending).toHaveLength(40);
      const enteringNodes = [...viewport.querySelectorAll<HTMLElement>('[data-message-id^="tool-"]')];
      expect(enteringNodes).toHaveLength(40);
      await scroll(viewport.scrollHeight);
      expect(enteringNodes.every((node) => node.isConnected)).toBe(true);
      expect(pending).toHaveLength(40);
      await act(async () => {
        for (const animation of pending) {
          animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
        }
      });
      await settle();
      expect(renderedIds().filter((id) => id?.startsWith('tool-'))).toHaveLength(40);
      expect(enteringNodes.every((node) => node.isConnected)).toBe(true);
      expect(pending).toHaveLength(40);
    } finally {
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it('keeps focused rows alive only until focus moves elsewhere', async () => {
    data[5000] = { ...data[5000], role: 'tool', toolResult: {
      toolName: 'bash', result: 'output', summary: 'focus-test', success: true, blocked: false,
    } };
    await render({ highlightMessageId: 'm5000' });
    const button = viewport.querySelector<HTMLButtonElement>('[data-message-id="m5000"] button')!;
    await act(async () => {
      button.focus();
      handle.current!.scrollToBottom();
    });
    await settle();
    expect(document.activeElement).toBe(button);
    expect(renderedIds()).toContain('m5000');
    await act(async () => {
      viewport.tabIndex = -1;
      viewport.focus();
    });
    await settle();
    expect(renderedIds()).not.toContain('m5000');
  });

  it('shows a retryable archive error without clearing history or repeatedly loading', async () => {
    data = fixture(10);
    const load = vi.fn().mockRejectedValueOnce({ kind: 'Storage', message: 'archive unavailable' })
      .mockImplementationOnce(async () => {
        useConversationStore.setState({ hasEarlierMessages: { test: false } });
      });
    useConversationStore.setState({
      activeConversationId: 'test', hasEarlierMessages: { test: true }, messages: { test: data },
      loadEarlierHistory: load,
    });
    await render({ highlightMessageId: 'm0' });
    expect(viewport.textContent).toContain('archive unavailable');
    expect(load).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().messages.test).toBe(data);
    const retry = [...viewport.querySelectorAll('button')].find((button) => button.textContent?.includes('重试'))!;
    await act(async () => retry.click());
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(viewport.textContent).not.toContain('archive unavailable');
  });

  it('follows streamed/async height growth in the real transcript, but respects a reader above the bottom', async () => {
    useConversationStore.setState({ messages: { test: data }, activeConversationId: 'test' });
    await act(async () => root.render(<AgentTranscript
      canInteract conversationId="test" rollbackDisabled={false} userJustSentRef={{ current: false }}
      onCopy={vi.fn()} onRollback={vi.fn()} emptyState={null}
    />));
    viewport = host.querySelector<HTMLDivElement>('.overflow-y-auto .overflow-y-auto')!;
    await settle();
    expect(renderedIds()).toContain('m9999');
    heights.set('m9999', 500);
    await settle();
    expect(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight).toBeLessThanOrEqual(1);
    await scroll(500000);
    const before = viewport.scrollTop;
    await act(async () => useConversationStore.getState().updateConversationMessages('test', (messages) => [
      ...messages, { id: 'stream-tail', role: 'assistant', content: 'new', timestamp: '' },
    ]));
    await settle();
    expect(viewport.scrollTop).toBe(before);
    expect(renderedIds()).not.toContain('stream-tail');
  });
});
