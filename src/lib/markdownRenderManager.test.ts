import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderManager } from './markdownRenderManager';
import type { MarkdownRequest, MarkdownResponse, MarkdownTree } from './markdownProcessor';

const tree: MarkdownTree = { type: 'root', children: [] };
class FakeWorker {
  onmessage: ((event: MessageEvent<MarkdownResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn<(request: MarkdownRequest) => void>();
  terminate = vi.fn();
  finish(index = this.postMessage.mock.calls.length - 1) {
    this.onmessage?.({ data: { id: this.postMessage.mock.calls[index][0].id, tree } } as MessageEvent<MarkdownResponse>);
  }
}
let worker: FakeWorker;
let manager: MarkdownRenderManager;
beforeEach(() => {
  vi.useFakeTimers();
  worker = new FakeWorker();
  manager = new MarkdownRenderManager(() => worker);
});
afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

describe('Markdown worker coordination', () => {
  it('keeps one parse in flight and coalesces 100 snapshots to the latest without starving progress', () => {
    const owner = Symbol();
    const deliver = vi.fn();
    let cancel = manager.request(owner, 'x', deliver);
    for (let i = 2; i <= 100; i++) {
      cancel();
      cancel = manager.request(owner, 'x'.repeat(i), deliver);
    }
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.finish();
    expect(deliver).toHaveBeenCalledWith(tree, 'x');
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage.mock.calls[1][0].text).toBe('x'.repeat(100));
    worker.finish();
    expect(deliver).toHaveBeenLastCalledWith(tree, 'x'.repeat(100));
    cancel();
    vi.advanceTimersByTime(5000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('does not leak a replaced message or an unmounted conversation into the next view', () => {
    const first = Symbol();
    const second = Symbol();
    const deliver = vi.fn();
    const other = vi.fn();
    const cancel = manager.request(first, 'old content', deliver);
    cancel();
    manager.request(first, 'replacement', deliver);
    manager.request(second, 'another conversation', other);
    worker.finish();
    expect(deliver).not.toHaveBeenCalled();
    worker.finish();
    expect(deliver).toHaveBeenCalledWith(tree, 'replacement');
    worker.finish();
    expect(other).toHaveBeenCalledWith(tree, 'another conversation');
  });

  it('removes cancelled queued work without losing other messages', () => {
    manager.request(Symbol(), 'running', vi.fn());
    const cancelled = vi.fn();
    manager.request(Symbol(), 'cancelled', cancelled)();
    const live = vi.fn();
    manager.request(Symbol(), 'live', live);
    worker.finish();
    expect(worker.postMessage.mock.calls[1][0].text).toBe('live');
    worker.finish();
    expect(live).toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it.each(['error', 'messageerror', 'timeout'])('falls back for every active client on %s', (failure) => {
    const callbacks = [vi.fn(), vi.fn()];
    callbacks.forEach((callback, i) => manager.request(Symbol(), `text${i}`, callback));
    if (failure === 'error') worker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    if (failure === 'messageerror') worker.onmessageerror?.({} as MessageEvent);
    if (failure === 'timeout') vi.advanceTimersByTime(15000);
    callbacks.forEach((callback, i) => expect(callback).toHaveBeenCalledWith(null, `text${i}`));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const next = vi.fn();
    manager.request(Symbol(), 'next', next);
    expect(next).toHaveBeenCalledWith(null, 'next');
  });

  it('handles worker construction and posting failure', () => {
    const callback = vi.fn();
    const broken = new MarkdownRenderManager(() => { throw new Error('unavailable'); });
    broken.request(Symbol(), 'keep text', callback);
    expect(callback).toHaveBeenCalledWith(null, 'keep text');
    worker.postMessage.mockImplementation(() => { throw new Error('closed'); });
    manager.request(Symbol(), 'still text', callback);
    expect(callback).toHaveBeenLastCalledWith(null, 'still text');
  });

  it('reuses recently parsed text across virtual remounts and bounds its cache', () => {
    const cancel = manager.request(Symbol(), 'recent', vi.fn());
    worker.finish();
    cancel();
    const cached = vi.fn();
    manager.request(Symbol(), 'recent', cached)();
    expect(cached).toHaveBeenCalledWith(tree, 'recent');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 25; i++) {
      const release = manager.request(Symbol(), `message-${i}`, vi.fn());
      worker.finish();
      release();
    }
    manager.request(Symbol(), 'recent', vi.fn());
    expect(worker.postMessage).toHaveBeenCalledTimes(27);
  });

  it('a cached replacement cancels an older in-flight request for that owner', () => {
    manager.request(Symbol(), 'cached', vi.fn())();
    worker.finish();
    // A cancelled request does not cache its result, so complete one while still subscribed.
    const stop = manager.request(Symbol(), 'cached', vi.fn());
    worker.finish();
    stop();
    const owner = Symbol();
    const old = vi.fn();
    manager.request(owner, 'old', old);
    const current = vi.fn();
    manager.request(owner, 'cached', current);
    worker.finish();
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledWith(tree, 'cached');
  });
});
