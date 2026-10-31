// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MarkdownBody from './MarkdownBody';
import { markdownRenderManager } from '@/lib/markdownRenderManager';
import type { MarkdownTree } from '@/lib/markdownProcessor';
import { MarkdownVisibility } from './markdownVisibility';

vi.mock('@/lib/markdownRenderManager', () => ({
  markdownRenderManager: { request: vi.fn(() => vi.fn()) },
}));
vi.mock('@/lib/externalLinks', () => ({ openExternalLink: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
const tree = (text: string): MarkdownTree => ({
  type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: text }] }],
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', class {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(content: string, live = false) {
  await act(async () => root.render(<MarkdownBody content={content} live={live} />));
}
async function deliver(text: string) {
  const calls = vi.mocked(markdownRenderManager.request).mock.calls;
  await act(async () => calls[calls.length - 1][2](tree(text), text));
}
it('does not wrap streamed text when the message is not live', async () => {
  await render('first', false);
  await deliver('first');
  await render('first next', false);
  await deliver('first next');
  expect(host.querySelectorAll('.ink-a, .ink-b').length).toBe(0);
});
it('shows streamed text as soon as it arrives, no display pacing', async () => {
  await render('a', true);
  await deliver('a');
  await render('ab', true);
  // 显示限速已经删掉：内容一到就上屏，不用等节拍、也不用等攒够字数。
  expect(host.textContent).toBe('ab');
  const requested = vi.mocked(markdownRenderManager.request).mock.calls.map((c) => c[1]);
  expect(requested).toContain('ab');
  await deliver('ab');
  const spans = [...host.querySelectorAll('.ink-a, .ink-b')];
  expect(spans.map((s) => s.textContent)).toEqual(['b']);
});
it('shows text immediately, then keeps parsed content while the next prefix is processed', async () => {
  await render('first');
  expect(host.textContent).toBe('first');
  expect(host.querySelector('p')).toBeNull();
  await deliver('first');
  expect(host.querySelector('p')?.textContent).toBe('first');
  await render('first next');
  expect(host.querySelector('p')?.textContent).toBe('first next');
  expect(host.querySelector('strong')).toBeNull();
  await deliver('first next');
  expect(host.textContent).toBe('first next');
});
it('does not show the old parsed answer after replacement', async () => {
  await render('old');
  await deliver('old');
  await render('replacement');
  expect(host.textContent).toBe('replacement');
  expect(host.querySelector('p')).toBeNull();
  await deliver('replacement');
  expect(host.querySelector('p')?.textContent).toBe('replacement');
});
it('falls back to safe Markdown on worker failure, without dropping the latest content', async () => {
  await render('**latest** <script>bad()</script>');
  const calls = vi.mocked(markdownRenderManager.request).mock.calls;
  await act(async () => calls[0][2](null, calls[0][1]));
  expect(host.querySelector('strong')?.textContent).toBe('latest');
  expect(host.querySelector('script')).toBeNull();
});
it('cancels queued work while hidden and requests only the latest content on return', async () => {
  const update = async (visible: boolean, content: string) => {
    await act(async () => root.render(
      <MarkdownVisibility.Provider value={visible}><MarkdownBody content={content} /></MarkdownVisibility.Provider>,
    ));
  };
  await update(true, 'first');
  const cancel = vi.mocked(markdownRenderManager.request).mock.results[0].value;
  await update(false, 'hidden');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(markdownRenderManager.request).toHaveBeenCalledTimes(1);
  await update(true, 'latest');
  expect(vi.mocked(markdownRenderManager.request).mock.calls[1][1]).toBe('latest');
});
