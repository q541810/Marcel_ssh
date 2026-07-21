import { describe, it, expect, vi } from 'vitest';
import {
  attachXtermMomentumScroll,
  consumeLines,
  estimateScrollVelocity,
  shouldStartFling,
  stepFling,
  DEFAULT_FLING_CONFIG,
} from './terminalMomentum';

describe('estimateScrollVelocity', () => {
  it('returns 0 for fewer than 2 samples', () => {
    expect(estimateScrollVelocity([])).toBe(0);
    expect(estimateScrollVelocity([{ t: 0, y: 10 }])).toBe(0);
  });

  it('is positive when finger moves up (scroll content down)', () => {
    // pageY decreases over 50ms by 100px → 2 px/ms
    const v = estimateScrollVelocity([
      { t: 0, y: 200 },
      { t: 50, y: 100 },
    ]);
    expect(v).toBeCloseTo(2, 5);
  });

  it('is negative when finger moves down', () => {
    const v = estimateScrollVelocity([
      { t: 0, y: 100 },
      { t: 50, y: 200 },
    ]);
    expect(v).toBeCloseTo(-2, 5);
  });

  it('uses only samples inside the velocity window', () => {
    const v = estimateScrollVelocity(
      [
        { t: 0, y: 0 },
        { t: 200, y: 0 },
        { t: 250, y: -50 },
      ],
      100,
    );
    // window from 150..250; first sample in window is t=200
    expect(v).toBeCloseTo(1, 5);
  });
});

describe('stepFling', () => {
  it('decays velocity and produces positive delta for positive v', () => {
    const r = stepFling({
      velocityPxPerMs: 1,
      dtMs: 16,
      frictionPerMs: 0.003,
    });
    expect(r.deltaPx).toBeGreaterThan(0);
    expect(r.velocityPxPerMs).toBeLessThan(1);
    expect(r.velocityPxPerMs).toBeGreaterThan(0);
  });

  it('returns zero delta when dt is 0', () => {
    const r = stepFling({
      velocityPxPerMs: 1,
      dtMs: 0,
      frictionPerMs: 0.003,
    });
    expect(r.deltaPx).toBe(0);
    expect(r.velocityPxPerMs).toBe(1);
  });
});

describe('consumeLines', () => {
  it('accumulates residual across small steps', () => {
    const a = consumeLines(10, 0, 16);
    expect(a.lines).toBe(0);
    expect(a.residualPx).toBe(10);
    const b = consumeLines(10, a.residualPx, 16);
    expect(b.lines).toBe(1);
    expect(b.residualPx).toBe(4);
  });

  it('handles negative motion (scroll up)', () => {
    const r = consumeLines(-20, 0, 16);
    expect(r.lines).toBe(-1);
    expect(r.residualPx).toBeCloseTo(-4, 5);
  });

  it('tolerates invalid row height', () => {
    const r = consumeLines(10, 5, 0);
    expect(r.lines).toBe(0);
    expect(r.residualPx).toBe(15);
  });
});

describe('shouldStartFling', () => {
  it('rejects slow flicks', () => {
    expect(
      shouldStartFling({
        velocityPxPerMs: 0.1,
        travelY: 40,
        travelX: 0,
        hasSelection: false,
      }),
    ).toBe(false);
  });

  it('rejects selection gestures', () => {
    expect(
      shouldStartFling({
        velocityPxPerMs: 1,
        travelY: 40,
        travelX: 0,
        hasSelection: true,
      }),
    ).toBe(false);
  });

  it('rejects mostly-horizontal swipes', () => {
    expect(
      shouldStartFling({
        velocityPxPerMs: 1,
        travelY: 20,
        travelX: 80,
        hasSelection: false,
      }),
    ).toBe(false);
  });

  it('rejects velocity that disagrees with travel', () => {
    expect(
      shouldStartFling({
        velocityPxPerMs: 1,
        travelY: -40,
        travelX: 0,
        hasSelection: false,
      }),
    ).toBe(false);
  });

  it('accepts a normal vertical flick', () => {
    expect(
      shouldStartFling({
        velocityPxPerMs: 1,
        travelY: 40,
        travelX: 5,
        hasSelection: false,
      }),
    ).toBe(true);
  });

  it('uses DEFAULT_FLING_CONFIG thresholds', () => {
    expect(DEFAULT_FLING_CONFIG.minVelocityPxPerMs).toBeGreaterThan(0);
  });
});

describe('attachXtermMomentumScroll', () => {
  /** Minimal EventTarget + querySelector stub (vitest env is node, no jsdom). */
  function makeContainer() {
    type Listener = (ev: unknown) => void;
    const listeners = new Map<string, Set<Listener>>();
    const viewport = {
      className: 'xterm-viewport',
      clientHeight: 320,
    };
    const container = {
      querySelector(sel: string) {
        return sel === '.xterm-viewport' ? viewport : null;
      },
      addEventListener(type: string, fn: Listener) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener(type: string, fn: Listener) {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent(type: string, ev: unknown) {
        for (const fn of listeners.get(type) ?? []) fn(ev);
      },
    };
    return container;
  }

  function makeHarness() {
    const container = makeContainer();

    let viewportY = 50;
    const scrollLines = vi.fn((n: number) => {
      viewportY += n;
    });
    const term = {
      scrollLines,
      rows: 20,
      hasSelection: () => false,
      buffer: {
        get active() {
          return { viewportY };
        },
      },
    };

    let t = 1000;
    const frames: FrameRequestCallback[] = [];
    const handle = attachXtermMomentumScroll({
      container: container as unknown as HTMLElement,
      getTerminal: () => term,
      now: () => t,
      raf: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      caf: () => {
        frames.length = 0;
      },
      config: {
        minVelocityPxPerMs: 0.2,
        stopVelocityPxPerMs: 0.05,
        frictionPerMs: 0.002,
        minTravelPx: 8,
      },
    });

    const fire = (
      type: 'touchstart' | 'touchmove' | 'touchend',
      pageX: number,
      pageY: number,
      time: number,
    ) => {
      t = time;
      const touch = { pageX, pageY };
      container.dispatchEvent(type, {
        touches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      });
    };

    const runFrames = (n: number, dt = 16) => {
      for (let i = 0; i < n; i++) {
        const cb = frames.shift();
        if (!cb) break;
        t += dt;
        cb(t);
      }
    };

    return { handle, scrollLines, fire, runFrames, getY: () => viewportY };
  }

  it('flings after a fast upward flick and calls scrollLines', () => {
    const { handle, scrollLines, fire, runFrames } = makeHarness();
    fire('touchstart', 10, 300, 1000);
    fire('touchmove', 10, 250, 1020);
    fire('touchmove', 10, 180, 1040);
    fire('touchend', 10, 140, 1055);
    expect(scrollLines).not.toHaveBeenCalled();
    runFrames(8);
    expect(scrollLines.mock.calls.length).toBeGreaterThan(0);
    const total = scrollLines.mock.calls.reduce((s, [n]) => s + n, 0);
    expect(total).toBeGreaterThan(0);
    handle.dispose();
  });

  it('does not fling on a slow drag', () => {
    const { handle, scrollLines, fire, runFrames } = makeHarness();
    fire('touchstart', 10, 300, 1000);
    fire('touchmove', 10, 290, 1100);
    fire('touchend', 10, 285, 1200);
    runFrames(5);
    expect(scrollLines).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('stops fling on next touchstart', () => {
    const { handle, scrollLines, fire, runFrames } = makeHarness();
    fire('touchstart', 10, 300, 1000);
    fire('touchmove', 10, 200, 1020);
    fire('touchend', 10, 100, 1040);
    runFrames(2);
    const mid = scrollLines.mock.calls.length;
    expect(mid).toBeGreaterThan(0);
    fire('touchstart', 10, 100, 1100);
    runFrames(10);
    expect(scrollLines.mock.calls.length).toBe(mid);
    handle.dispose();
  });
});
