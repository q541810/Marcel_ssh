// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CONTENT_FADE_MS, LATE_CONTENT_MS, useShellFirst } from './useShellFirst';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let now = 0;
let frames: FrameRequestCallback[] = [];
let fades: Array<{ el: Element; duration: number }> = [];
let container: HTMLDivElement;
let root: Root;

function frame(gap = 16): void {
  now += gap;
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(now));
}

function Shell({ mounted }: { mounted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const show = useShellFirst(mounted, ref);
  if (!mounted) return null;
  return (
    <div ref={ref} data-testid="shell">
      {show ? (
        <>
          <h1>标题</h1>
          <div>内容</div>
        </>
      ) : null}
    </div>
  );
}

const content = () => container.querySelector('h1');

beforeEach(() => {
  now = 0;
  frames = [];
  fades = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Element.prototype.animate = function (this: Element, _k: unknown, o?: number | KeyframeAnimationOptions) {
    fades.push({ el: this, duration: typeof o === 'object' ? Number(o.duration) : Number(o) });
    return {} as Animation;
  } as typeof Element.prototype.animate;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useShellFirst', () => {
  it('commits the empty card first and the content once that frame is out', () => {
    act(() => root.render(<Shell mounted />));
    expect(container.querySelector('[data-testid="shell"]')).not.toBeNull();
    expect(content()).toBeNull();
    act(() => {
      frame();
      vi.runAllTimers();
    });
    expect(content()).not.toBeNull();
    // Came while the card was still small: no fade.
    expect(fades).toHaveLength(0);
  });

  it('fades content in when it lands after the card is already big', () => {
    act(() => root.render(<Shell mounted />));
    act(() => {
      frame(LATE_CONTENT_MS + 50); // a long first frame
      vi.runAllTimers();
    });
    expect(content()).not.toBeNull();
    expect(fades.map((f) => f.el.tagName)).toEqual(['H1', 'DIV']);
    expect(fades.every((f) => f.duration === CONTENT_FADE_MS)).toBe(true);
  });

  it('goes shell-first again on every opening', () => {
    act(() => root.render(<Shell mounted />));
    act(() => {
      frame();
      vi.runAllTimers();
    });
    act(() => root.render(<Shell mounted={false} />));
    act(() => root.render(<Shell mounted />));
    expect(content()).toBeNull();
    act(() => {
      frame();
      vi.runAllTimers();
    });
    expect(content()).not.toBeNull();
  });

  it('renders the content with the shell when nothing animates', () => {
    delete (Element.prototype as { animate?: unknown }).animate;
    act(() => root.render(<Shell mounted />));
    expect(content()).not.toBeNull();
  });
});
