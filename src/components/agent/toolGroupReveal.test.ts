// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupRevealFrames, ToolGroupReveal } from './toolGroupReveal';

function heightAt(frames: Keyframe[], progress: number) {
  const right = frames.findIndex((frame) => Number(frame.offset) >= progress);
  if (right === 0) return parseFloat(String(frames[0].height));
  const a = frames[right - 1];
  const b = frames[right];
  const ratio = (progress - Number(a.offset)) / (Number(b.offset) - Number(a.offset));
  return parseFloat(String(a.height)) + (parseFloat(String(b.height)) - parseFloat(String(a.height))) * ratio;
}

describe('groupRevealFrames', () => {
  it.each([[0, 116], [30, 116], [116, 0], [110, 18], [56, 56]])(
    'moves one reveal boundary from %i to %i without compressing preceding cards', (from, to) => {
      const heights = [24, 32, 60];
      const offsets = [0, 24, 56];
      const frames = heights.map((height, index) => groupRevealFrames(offsets[index], height, from, to));
      for (let step = 0; step <= 100; step++) {
        const progress = step / 100;
        const visible = frames.map((frame) => heightAt(frame, progress));
        const boundary = from + (to - from) * progress;
        expect(visible.reduce((sum, height) => sum + height, 0)).toBeCloseTo(boundary, 8);
        for (let index = 0; index < heights.length; index++) {
          expect(visible[index]).toBeCloseTo(Math.max(0, Math.min(heights[index], boundary - offsets[index])), 8);
          if (visible[index] > 0.000001) {
            for (let previous = 0; previous < index; previous++) expect(visible[previous]).toBeCloseTo(heights[previous], 8);
          }
        }
      }
    },
  );
});

describe('ToolGroupReveal coordinator', () => {
  let coordinator: ToolGroupReveal;
  let animations: Array<{ node: HTMLElement; frames: Keyframe[]; animation: Animation; finish: () => void }>;
  let observer: { observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

  function member(key: string, height: number, group = 'group', closing = false) {
    const node = document.createElement('div');
    const inner = document.createElement('div');
    node.append(inner);
    document.body.append(node);
    node.style.height = 'auto';
    node.style.overflow = 'visible';
    vi.spyOn(inner, 'getBoundingClientRect').mockImplementation(() => ({ height } as DOMRect));
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => ({ height: parseFloat(node.style.height) || 0 } as DOMRect));
    const done = vi.fn();
    const unregister = coordinator.register(group, key, node, inner, done, closing ? height : 0, closing);
    return { node, inner, done, unregister };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new ToolGroupReveal();
    animations = [];
    observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    vi.stubGlobal('ResizeObserver', class { observe = observer.observe; unobserve = observer.unobserve; disconnect = observer.disconnect; });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(500), 16));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Object.defineProperty(document, 'timeline', { configurable: true, value: { currentTime: 500 } });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: function (this: HTMLElement, frames: Keyframe[]) {
        const animation = { cancel: vi.fn(), onfinish: null, startTime: null } as unknown as Animation;
        animations.push({ node: this, frames, animation, finish() {
          animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
        } });
        return animation;
      },
    });
  });

  afterEach(() => {
    coordinator.dispose();
    document.body.replaceChildren();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    delete (document as unknown as { timeline?: unknown }).timeline;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shares one start time and releases the group only after every animation finishes', () => {
    const members = [member('a', 24), member('b', 32), member('c', 60)];
    expect(animations).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(animations).toHaveLength(3);
    expect(animations.map(({ animation }) => animation.startTime)).toEqual([500, 500, 500]);
    animations[2].finish();
    animations[0].finish();
    for (const entry of members) {
      expect(entry.done).not.toHaveBeenCalled();
      expect(entry.node.style.overflow).toBe('hidden');
    }
    animations[1].finish();
    for (const entry of members) {
      expect(entry.done).toHaveBeenCalledOnce();
      expect(entry.node.style.height).toBe('auto');
      expect(entry.node.style.overflow).toBe('visible');
    }
    expect(observer.disconnect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    for (const entry of members) expect(entry.done).toHaveBeenCalledOnce();
  });

  it.each([0, 16])('dispose cleans pending frames, animations and observers after %i ms', (elapsed) => {
    const entry = member('a', 24);
    vi.advanceTimersByTime(elapsed);
    coordinator.dispose();
    expect(entry.node.style.height).toBe('auto');
    expect(entry.node.style.overflow).toBe('visible');
    expect(observer.disconnect).toHaveBeenCalledOnce();
    for (const { animation, finish } of animations) {
      expect(animation.cancel).toHaveBeenCalled();
      finish();
    }
    vi.advanceTimersByTime(2000);
    expect(entry.done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unregister cancels the removed node and never calls its completion callback', () => {
    const removed = member('a', 24);
    const retained = member('b', 32);
    vi.advanceTimersByTime(16);
    removed.unregister();
    expect(animations[0].animation.cancel).toHaveBeenCalled();
    expect(removed.node.style.height).toBe('auto');
    animations[0].finish();
    animations[1].finish();
    vi.advanceTimersByTime(16);
    expect(animations).toHaveLength(3);
    animations[2].finish();
    expect(removed.done).not.toHaveBeenCalled();
    expect(retained.done).toHaveBeenCalledOnce();
    expect(observer.unobserve).toHaveBeenCalledWith(removed.inner);
    vi.advanceTimersByTime(2000);
    expect(removed.done).not.toHaveBeenCalled();
  });

  it('does not hold an independent group while another group remains active', () => {
    const first = member('a', 24, 'first');
    const second = member('a', 32, 'second');
    vi.advanceTimersByTime(16);
    animations[0].finish();
    expect(first.done).toHaveBeenCalledOnce();
    expect(second.done).not.toHaveBeenCalled();
    animations[1].finish();
    expect(second.done).toHaveBeenCalledOnce();
  });

  it('collapses one shared boundary and reverses without redistributing visible card heights', () => {
    const first = member('a', 24, 'close', true);
    const second = member('b', 32, 'close', true);
    vi.advanceTimersByTime(16);
    expect(animations[0].frames[animations[0].frames.length - 1]?.height).toBe('0px');
    expect(animations[1].frames[animations[1].frames.length - 1]?.height).toBe('0px');
    const midpoint = animations.map(({ frames }) => heightAt(frames, 0.5));
    expect(midpoint).toEqual([24, 4]);
    first.unregister();
    second.unregister();
    const done = vi.fn();
    coordinator.register('open', 'a', first.node, first.inner, done, midpoint[0]);
    coordinator.register('open', 'b', second.node, second.inner, done, midpoint[1]);
    vi.advanceTimersByTime(16);
    expect(animations.slice(2).map(({ frames }) => frames[0].height)).toEqual(['24px', '4px']);
    animations[2].finish();
    animations[3].finish();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it('holds completed collapsed rows at zero until their removal is committed', () => {
    const entry = member('a', 24, 'close', true);
    vi.advanceTimersByTime(16);
    animations[0].finish();
    expect(entry.done).toHaveBeenCalledOnce();
    expect(entry.node.style.height).toBe('0px');
    expect(entry.node.style.overflow).toBe('hidden');
  });
});
