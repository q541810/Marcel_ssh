// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackDiagnostics,
  registerBackHandler,
  resetBackHandlers,
  type BackGestureFrame,
  type BackPreview,
} from './backHandler';
import { EDGE_PX, installEdgeSwipeBack } from './edgeSwipeBack';

const WIDTH = 400;

function makePreview() {
  const calls: string[] = [];
  const frames: BackGestureFrame[] = [];
  const preview: BackPreview = {
    start: (edge) => calls.push(`start:${edge}`),
    update: (f) => {
      calls.push('update');
      frames.push(f);
    },
    cancel: () => calls.push('cancel'),
    commit: () => calls.push('commit'),
  };
  return { preview, calls, frames };
}

let uninstall: () => void;
let clock = 0;

function touchList(id: number, x: number, y: number, target: EventTarget): Touch[] {
  return [{ identifier: id, clientX: x, clientY: y, target } as unknown as Touch];
}

/** jsdom has no Touch constructor: build the event by hand. */
function fire(type: string, x: number, y: number, opts: { cancelable?: boolean } = {}) {
  const target = document.body;
  const ev = new Event(type, { bubbles: true, cancelable: opts.cancelable ?? true });
  const t = touchList(1, x, y, target);
  const live = type === 'touchend' || type === 'touchcancel' ? [] : t;
  Object.defineProperties(ev, {
    touches: { value: live },
    changedTouches: { value: t },
    timeStamp: { value: clock },
  });
  target.dispatchEvent(ev);
  return ev;
}

/** Drag along a path, 16 ms per step. */
function drag(points: Array<[number, number]>, stepMs = 16): Event[] {
  const events: Event[] = [];
  points.forEach(([x, y], i) => {
    clock += i === 0 ? 0 : stepMs;
    events.push(fire(i === 0 ? 'touchstart' : 'touchmove', x, y));
  });
  return events;
}

beforeEach(() => {
  clock = 1000;
  Object.defineProperty(window, 'innerWidth', { value: WIDTH, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  resetBackHandlers();
  uninstall = installEdgeSwipeBack();
});

afterEach(() => {
  uninstall();
  resetBackHandlers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await Promise.resolve();
}

describe('edge swipe back', () => {
  it('follows an inward swipe from the left edge 1:1 and commits past the line', async () => {
    const { preview, calls, frames } = makePreview();
    const close = vi.fn();
    registerBackHandler(close, preview);
    await flush();

    // 20 → 220 px over 6 steps (slow, no fling): progress 0.5 at release
    drag([
      [20, 400],
      [40, 402],
      [90, 404],
      [140, 406],
      [190, 408],
      [220, 410],
    ], 60);
    expect(calls[0]).toBe('start:left');
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1].progress).toBeCloseTo((220 - 20) / WIDTH, 3);
    // Absolute finger Y reaches the preview (for the tilt).
    expect(frames[frames.length - 1].y).toBe(410);

    clock += 60;
    fire('touchend', 220, 410);
    expect(calls.slice(-1)).toEqual(['commit']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getBackDiagnostics().touchCommits).toBeGreaterThan(0);
  });

  it('works from the right edge too (inward = leftward)', async () => {
    const { preview, calls, frames } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    drag([
      [WIDTH - 10, 300],
      [WIDTH - 60, 302],
      [WIDTH - 160, 304],
    ], 60);
    expect(calls[0]).toBe('start:right');
    expect(frames[frames.length - 1].progress).toBeCloseTo(150 / WIDTH, 3);
  });

  it('a first move of exactly the slop distance still starts the swipe', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    drag([
      [20, 400],
      [28, 400],
    ]);
    expect(calls[0]).toBe('start:left');
  });

  it('settles back when released short of the line', async () => {
    const { preview, calls } = makePreview();
    const close = vi.fn();
    registerBackHandler(close, preview);
    await flush();
    drag([
      [20, 400],
      [40, 400],
      [70, 401],
      [90, 401],
    ], 80);
    clock += 80;
    fire('touchend', 90, 401);
    expect(calls.slice(-1)).toEqual(['cancel']);
    expect(close).not.toHaveBeenCalled();
  });

  it('commits a quick flick even if it is short', async () => {
    const { preview, calls } = makePreview();
    const close = vi.fn();
    registerBackHandler(close, preview);
    await flush();
    // 80 px in ~48 ms ≈ 4 screen widths / s
    drag([
      [20, 400],
      [50, 400],
      [75, 400],
      [100, 400],
    ], 16);
    clock += 16;
    fire('touchend', 100, 400);
    expect(calls.slice(-1)).toEqual(['commit']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a finger that paused before lifting is not a fling', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    // fast move to progress 0.2, then hold still for 300 ms, then lift
    drag([
      [20, 400],
      [50, 400],
      [80, 400],
      [100, 400],
    ], 16);
    clock += 300;
    fire('touchend', 100, 400);
    expect(calls.slice(-1)).toEqual(['cancel']);
  });

  it('does not commit when the finger was heading back at release', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    drag([
      [20, 400],
      [100, 400],
      [180, 400],
      [140, 400],
      [100, 400],
    ], 16);
    clock += 16;
    fire('touchend', 100, 400);
    expect(calls.slice(-1)).toEqual(['cancel']);
  });

  it('prevents default (stops the scroll) once the swipe is ours', async () => {
    registerBackHandler(() => {}, makePreview().preview);
    await flush();
    const events = drag([
      [20, 400],
      [60, 402],
      [100, 404],
    ]);
    expect(events[0].defaultPrevented).toBe(false); // touchstart: taps must still work
    expect(events[1].defaultPrevented).toBe(true);
    expect(events[2].defaultPrevented).toBe(true);
  });

  it('ignores touches that start away from the edge', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    drag([
      [EDGE_PX + 20, 400],
      [EDGE_PX + 80, 400],
      [EDGE_PX + 160, 400],
    ]);
    fire('touchend', EDGE_PX + 160, 400);
    expect(calls).toEqual([]);
  });

  it('leaves vertical scrolls from the edge alone', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    const events = drag([
      [20, 400],
      [24, 440],
      [26, 520],
    ]);
    expect(calls).toEqual([]);
    expect(events.every((e) => !e.defaultPrevented)).toBe(true);
  });

  it('does nothing when the top layer has no preview', async () => {
    const close = vi.fn();
    registerBackHandler(close);
    await flush();
    drag([
      [20, 400],
      [120, 400],
      [220, 400],
    ]);
    fire('touchend', 220, 400);
    expect(close).not.toHaveBeenCalled();
  });

  it('honours data-no-edge-swipe', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    const host = document.createElement('div');
    host.setAttribute('data-no-edge-swipe', '');
    const inner = document.createElement('span');
    host.appendChild(inner);
    document.body.appendChild(host);
    const ev = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperties(ev, {
      touches: { value: touchList(1, 10, 400, inner) },
      changedTouches: { value: touchList(1, 10, 400, inner) },
      timeStamp: { value: clock },
    });
    inner.dispatchEvent(ev);
    clock += 16;
    fire('touchmove', 80, 400);
    host.remove();
    expect(calls).toEqual([]);
  });

  it('after touchcancel (system took the finger) holds the pose, then gives up', async () => {
    vi.useFakeTimers();
    try {
      const { preview, calls } = makePreview();
      registerBackHandler(() => {}, preview);
      await flush();
      drag([
        [20, 400],
        [60, 400],
        [100, 400],
      ]);
      fire('touchcancel', 100, 400);
      expect(calls).not.toContain('cancel'); // still holding the pose
      vi.advanceTimersByTime(250);
      expect(calls.slice(-1)).toEqual(['cancel']); // nobody committed: settle back
    } finally {
      vi.useRealTimers();
    }
  });

  it('after touchcancel the system commit continues from the held pose', async () => {
    vi.useFakeTimers();
    try {
      const { preview, calls } = makePreview();
      const close = vi.fn();
      registerBackHandler(close, preview);
      await flush();
      drag([
        [20, 400],
        [60, 400],
        [100, 400],
      ]);
      fire('touchcancel', 100, 400);
      window.__marcelHandleBack?.(); // the system's commit arrives
      expect(calls.slice(-1)).toEqual(['commit']);
      expect(close).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(calls).not.toContain('cancel'); // the grace timer must not fire afterwards
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands over to the system when it reports the same swipe (no flinch)', async () => {
    const { preview, calls } = makePreview();
    registerBackHandler(() => {}, preview);
    await flush();
    drag([
      [20, 400],
      [60, 400],
    ]);
    const starts = calls.filter((c) => c.startsWith('start')).length;
    window.__marcelBackStart?.(0, 400);
    expect(calls.filter((c) => c.startsWith('start')).length).toBe(starts);
    expect(calls).not.toContain('cancel');
  });
});
