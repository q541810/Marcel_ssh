// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useTurnFoldStore } from '@/stores/turnFoldStore';
import { setForcedPlatform } from '@/platform';
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
const itemHeight = 96;
let heights: Map<string, number>;
class ResizeMock {
  static all = new Set<ResizeMock>();
  elements = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { ResizeMock.all.add(this); }
  observe = (element: Element) => { this.elements.add(element); };
  unobserve = (element: Element) => { this.elements.delete(element); };
  disconnect = () => { this.elements.clear(); ResizeMock.all.delete(this); };
}
function rowHeight(node: HTMLElement): number | undefined {
  const collection = node.matches('[data-virtual-row-collection]') ? node
    : node.querySelector<HTMLElement>(':scope > [data-virtual-row-collection]');
  if (collection) return Array.from(collection.children).reduce((sum, child) => sum + (rowHeight(child as HTMLElement) ?? 0), 0);
  const row = node.matches('[data-virtual-row-key]') ? node
    : node.querySelector<HTMLElement>(':scope > [data-virtual-row-key]');
  if (!row) return;
  if (row.dataset.virtualRowHidden === 'true') return 0;
  const key = row.dataset.virtualRowKey!;
  if (key.startsWith('group:') || key.startsWith('turn:')) return 28;
  return heights.get(key.replace(/^message:/, '')) ?? itemHeight;
}
const dimensions = (node: HTMLElement): { width: number; height: number } => ({
  width: 420,
  height: node === viewport ? 260 : rowHeight(node) ?? (Number.parseFloat(node.style.height) || 0),
});
function relativeTop(node: HTMLElement): number {
  if (node === viewport) return 0;
  let top = -viewport.scrollTop;
  for (let current: HTMLElement | null = node; current && current !== viewport; current = current.parentElement) {
    top += Number.parseFloat(current.style.top) || 0;
  }
  return top;
}
function fixture(count: number): AgentMessage[] {
  // One large unfinished turn must itself be virtualized, not a single huge row.
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`, role: i === 0 ? 'user' : 'assistant', content: `text-${i}`, timestamp: '',
  }));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  heights = new Map();
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
    const top = relativeTop(this);
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


async function mountTranscript(mobile = false) {
  data = [
    ...fixture(120).map((message, index) => ({ ...message, role: index % 12 === 0 ? 'user' as const : 'assistant' as const })),
    { id: 'request', role: 'user', content: 'Run the tools', timestamp: '' },
    ...Array.from({ length: 30 }, (_, index): AgentMessage => ({
      id: `tool-${index}`, role: 'tool', content: '', timestamp: '',
      toolResult: { toolName: ['bash', 'write_file', 'edit_file'][index % 3], summary: `Operation ${index}`,
        result: 'output', success: true, blocked: false },
    })),
    { id: 'answer', role: 'assistant', content: 'Finished', timestamp: '' },
  ];
  for (let index = 0; index < 30; index++) heights.set(`tool-${index}`, 32 + index % 4 * 28);
  heights.set('answer', 100);
  useConversationStore.setState({ messages: { test: data }, activeConversationId: 'test' });
  await act(async () => root.render(<AgentTranscript canInteract conversationId="test" mobile={mobile}
    rollbackDisabled={false} userJustSentRef={{ current: false }}
    onCopy={vi.fn()} onRollback={vi.fn()} emptyState={null} />));
  viewport = host.querySelector<HTMLDivElement>('.overflow-y-auto .overflow-y-auto')!;
  await settle();
}
function group() {
  const row = viewport.querySelector<HTMLElement>('[data-virtual-row-key="group:tools:tool-0"]');
  if (!row) throw new Error('Tool group is not rendered');
  return row;
}
async function toggleGroup() {
  const button = group().querySelector<HTMLButtonElement>('button')!;
  await act(async () => {
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    button.click();
  });
  await settle();
}
async function mouseToggleGroup() {
  const button = group().querySelector<HTMLButtonElement>('button')!;
  await act(async () => {
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    button.focus();
  });
  // A focus-driven keepMounted update is committed before the physical release.
  await settle();
  expect(button.isConnected).toBe(true);
  expect(group().querySelector('button')).toBe(button);
  await act(async () => {
    button.dispatchEvent(new Event('pointerup', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    button.click();
  });
  await settle();
}
function bottomDistance() {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
}

describe('folding in the actual scrolling transcript', () => {
  it('keeps the disclosure target mounted between pointer press, focus and release', async () => {
    await mountTranscript();
    await mouseToggleGroup();
    expect(group().querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
    await mouseToggleGroup();
    expect(group().querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it.each([false, true])('keeps the clicked group in place when expanding from the bottom (mobile=%s)', async (mobile) => {
    await mountTranscript(mobile);
    expect(bottomDistance()).toBeLessThanOrEqual(1);
    const before = group().getBoundingClientRect().top;
    expect(before).toBeGreaterThanOrEqual(0);
    await toggleGroup();
    expect(group().querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(Math.abs(group().getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    // The second measurement wave must not restore stale sticky-bottom intent.
    await settle();
    expect(Math.abs(group().getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
  });

  it.each([false, true])('does not jump after collapsing and then scrolling to the bottom (mobile=%s)', async (mobile) => {
    await mountTranscript(mobile);
    const before = group().getBoundingClientRect().top;
    await toggleGroup();
    await toggleGroup();
    expect(group().querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
    expect(Math.abs(group().getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    await scroll(viewport.scrollHeight);
    expect(bottomDistance()).toBeLessThanOrEqual(1);
    const after = viewport.scrollTop;
    await settle();
    expect(viewport.scrollTop).toBe(after);
    expect(bottomDistance()).toBeLessThanOrEqual(1);
    expect(renderedIds()).toContain('answer');
  });
});
