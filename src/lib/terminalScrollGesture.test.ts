import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_REMOTE_LINES_PER_FORWARD,
  WHEEL_LINES_PER_NOTCH,
  appAcceptsWheelReports,
  attachAltScreenTouchScroll,
  consumeLines,
  consumeWheelNotches,
  createLineAccumulator,
  createRemoteScrollForwarder,
  measureRowHeightPx,
  planRemoteScroll,
  type MouseTrackingMode,
} from './terminalScrollGesture';

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

describe('createLineAccumulator', () => {
  it('keeps the sub-row remainder between calls', () => {
    const acc = createLineAccumulator(() => 16);
    expect(acc.add(10)).toBe(0);
    expect(acc.add(10)).toBe(1);
    expect(acc.add(-26)).toBe(-1);
  });

  it('reset drops the remainder', () => {
    const acc = createLineAccumulator(() => 16);
    acc.add(10);
    acc.reset();
    expect(acc.add(10)).toBe(0);
  });

  it('drops non-finite input instead of poisoning the remainder', () => {
    const acc = createLineAccumulator(() => 16);
    expect(acc.add(Number.NaN)).toBe(0);
    expect(acc.add(Number.POSITIVE_INFINITY)).toBe(0);
    // 余量还得是干净的：此后 16px 仍然算得出一行
    expect(acc.add(16)).toBe(1);
  });
});

describe('appAcceptsWheelReports', () => {
  it('is true for the protocols that carry WHEEL events', () => {
    for (const mode of ['vt200', 'drag', 'any'] as MouseTrackingMode[]) {
      expect(appAcceptsWheelReports(mode)).toBe(true);
    }
  });

  it('is false for none and X10 (DECSET 9 has no wheel)', () => {
    for (const mode of ['none', 'x10'] as MouseTrackingMode[]) {
      expect(appAcceptsWheelReports(mode)).toBe(false);
    }
  });
});

describe('consumeWheelNotches', () => {
  it('carries the remainder so slow drags still reach a notch', () => {
    const a = consumeWheelNotches(-1, 0, WHEEL_LINES_PER_NOTCH);
    expect(a.notches).toBe(0);
    expect(a.residual).toBe(-1);
    const b = consumeWheelNotches(-2, a.residual, WHEEL_LINES_PER_NOTCH);
    expect(b.notches).toBe(-1);
    expect(b.residual).toBe(0);
  });

  it('splits large deltas into whole notches', () => {
    const r = consumeWheelNotches(10, 0, 3);
    expect(r.notches).toBe(3);
    expect(r.residual).toBe(1);
  });
});

describe('planRemoteScroll', () => {
  const point = { clientX: 7, clientY: 9 };

  it('sends one wheel event per notch when the remote accepts wheel reports', () => {
    const plan = planRemoteScroll({ lines: -10, residual: 0, acceptsWheel: true, point });
    expect(plan.events).toHaveLength(3);
    for (const ev of plan.events) {
      expect(ev).toEqual({ deltaY: -1, deltaMode: 1, clientX: 7, clientY: 9 });
    }
    expect(plan.residual).toBe(-1);
  });

  it('sends the whole line delta as one event when only arrow keys are available', () => {
    const plan = planRemoteScroll({ lines: -10, residual: 2, acceptsWheel: false, point });
    expect(plan.events).toEqual([{ deltaY: -10, deltaMode: 1, clientX: 7, clientY: 9 }]);
    expect(plan.residual).toBe(0);
  });

  it('plans nothing for a zero delta and keeps the residual', () => {
    const plan = planRemoteScroll({ lines: 0, residual: -2, acceptsWheel: true, point });
    expect(plan.events).toEqual([]);
    expect(plan.residual).toBe(-2);
  });

  it('caps a runaway delta instead of flooding the remote', () => {
    const wheel = planRemoteScroll({ lines: -5000, residual: 0, acceptsWheel: true, point });
    expect(wheel.events).toHaveLength(MAX_REMOTE_LINES_PER_FORWARD / WHEEL_LINES_PER_NOTCH);
    const arrows = planRemoteScroll({ lines: 5000, residual: 0, acceptsWheel: false, point });
    expect(arrows.events).toEqual([
      { deltaY: MAX_REMOTE_LINES_PER_FORWARD, deltaMode: 1, clientX: 7, clientY: 9 },
    ]);
  });
});

/** vitest runs in node, where WheelEvent does not exist. */
class FakeWheelEvent {
  type: string;
  deltaY = 0;
  deltaMode = 0;
  clientX = 0;
  clientY = 0;
  constructor(type: string, init: Record<string, unknown>) {
    this.type = type;
    Object.assign(this, init);
  }
}

interface FakeTerminalOptions {
  mode?: MouseTrackingMode;
  bufferType?: 'normal' | 'alternate';
  withElement?: boolean;
}

function makeFakeTerminal(dispatched: FakeWheelEvent[], options: FakeTerminalOptions = {}) {
  return {
    modes: { mouseTrackingMode: options.mode ?? ('none' as MouseTrackingMode) },
    element:
      options.withElement === false
        ? null
        : {
            dispatchEvent: (ev: Event) => {
              dispatched.push(ev as unknown as FakeWheelEvent);
              return true;
            },
          },
    buffer: { active: { type: options.bufferType ?? ('alternate' as const) } },
  };
}

describe('createRemoteScrollForwarder', () => {
  let dispatched: FakeWheelEvent[];

  beforeEach(() => {
    dispatched = [];
    vi.stubGlobal('WheelEvent', FakeWheelEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const point = { clientX: 3, clientY: 4 };

  it('forwards a wheel report per notch while in the alternate buffer', () => {
    const forwarder = createRemoteScrollForwarder(() => makeFakeTerminal(dispatched, { mode: 'drag' }));
    forwarder.forward(-4, point);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.deltaY).toBe(-1);
    expect(dispatched[0]!.deltaMode).toBe(1);
    expect(dispatched[0]!.clientX).toBe(3);
  });

  it('sends arrow-key deltas when the app does not accept wheel reports', () => {
    const forwarder = createRemoteScrollForwarder(() => makeFakeTerminal(dispatched, { mode: 'x10' }));
    forwarder.forward(-4, point);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.deltaY).toBe(-4);
  });

  it('never touches the normal buffer (xterm scrolls it locally)', () => {
    const forwarder = createRemoteScrollForwarder(() =>
      makeFakeTerminal(dispatched, { mode: 'drag', bufferType: 'normal' }),
    );
    forwarder.forward(-40, point);
    expect(dispatched).toHaveLength(0);
  });

  it('is a no-op without a terminal or an element', () => {
    const noTerm = createRemoteScrollForwarder(() => null);
    noTerm.forward(-40, point);
    const noElement = createRemoteScrollForwarder(() =>
      makeFakeTerminal(dispatched, { mode: 'drag', withElement: false }),
    );
    noElement.forward(-40, point);
    expect(dispatched).toHaveLength(0);
  });

  it('carries the notched remainder across gestures until reset', () => {
    const forwarder = createRemoteScrollForwarder(() => makeFakeTerminal(dispatched, { mode: 'drag' }));
    forwarder.forward(-1, point);
    expect(dispatched).toHaveLength(0);
    forwarder.forward(-2, point);
    expect(dispatched).toHaveLength(1);
    forwarder.reset();
    forwarder.forward(-2, point);
    expect(dispatched).toHaveLength(1);
  });

  it('works when forward is passed around detached (no `this`)', () => {
    const { forward } = createRemoteScrollForwarder(() =>
      makeFakeTerminal(dispatched, { mode: 'drag' }),
    );
    forward(-3, point);
    expect(dispatched).toHaveLength(1);
  });

  it('ignores non-finite line counts', () => {
    const forwarder = createRemoteScrollForwarder(() => makeFakeTerminal(dispatched, { mode: 'drag' }));
    forwarder.forward(Number.NaN, point);
    forwarder.forward(-3, point);
    expect(dispatched).toHaveLength(1);
  });
});

describe('measureRowHeightPx', () => {
  it('divides the viewport height by the row count', () => {
    const container = {
      querySelector: (sel: string) =>
        sel === '.xterm-viewport' ? { clientHeight: 320 } : null,
    } as unknown as ParentNode;
    expect(measureRowHeightPx(container, 20)).toBe(16);
  });

  it('falls back when the terminal is not laid out', () => {
    const container = { querySelector: () => null } as unknown as ParentNode;
    expect(measureRowHeightPx(container, 20)).toBe(16);
  });
});

describe('attachAltScreenTouchScroll', () => {
  /** Minimal EventTarget + querySelector stub (vitest env is node, no jsdom). */
  function makeContainer() {
    type Listener = (ev: unknown) => void;
    const listeners = new Map<string, Set<Listener>>();
    const viewport = { clientHeight: 320 };
    return {
      querySelector: (sel: string) => (sel === '.xterm-viewport' ? viewport : null),
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
      dispatch(type: string, ev: unknown) {
        for (const fn of listeners.get(type) ?? []) fn(ev);
      },
      listenerCount: () =>
        Array.from(listeners.values()).reduce((total, set) => total + set.size, 0),
    };
  }

  function makeHarness(bufferType: 'normal' | 'alternate' = 'alternate') {
    const container = makeContainer();
    const forward = vi.fn();
    const term = {
      modes: { mouseTrackingMode: 'none' as MouseTrackingMode },
      element: null,
      rows: 20,
      hasSelection: () => false,
      scrollLines: vi.fn(),
      buffer: { active: { type: bufferType as 'normal' | 'alternate' } },
    };
    const handle = attachAltScreenTouchScroll({
      container: container as unknown as HTMLElement,
      getTerminal: () => term,
      forward,
    });
    const start = (clientY: number) =>
      container.dispatch('touchstart', { touches: [{ clientX: 5, clientY }] });
    const move = (clientY: number, touches = 1) => {
      const list = Array.from({ length: touches }, (_, i) => ({
        clientX: 5,
        clientY,
        identifier: i,
      }));
      container.dispatch('touchmove', { touches: list });
    };
    return { handle, forward, start, move, container, term };
  }

  it('forwards finger travel as lines in the alternate buffer', () => {
    const { handle, forward, start, move } = makeHarness();
    start(300);
    move(260); // finger up 40px, row height 320/20 = 16 → 2 lines toward newer content
    expect(forward).toHaveBeenCalledWith(2, { clientX: 5, clientY: 260 });
    handle.dispose();
  });

  it('ignores gestures in the normal buffer (xterm scrolls locally)', () => {
    const { handle, forward, start, move } = makeHarness('normal');
    start(300);
    move(200);
    expect(forward).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('ignores multi-touch', () => {
    const { handle, forward, start, move } = makeHarness();
    start(300);
    move(200, 2);
    expect(forward).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('drops the gesture when the buffer switches back to normal mid-drag', () => {
    const { handle, forward, start, move, term } = makeHarness();
    start(300);
    move(260);
    expect(forward).toHaveBeenCalledTimes(1);
    term.buffer.active.type = 'normal';
    move(220);
    move(180);
    expect(forward).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('starts each gesture fresh instead of carrying stale travel', () => {
    const { handle, forward, start, move } = makeHarness();
    start(300);
    move(290); // 10px, below one row
    expect(forward).not.toHaveBeenCalled();
    start(300);
    move(290);
    expect(forward).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('detaches every listener on dispose', () => {
    const { handle, container } = makeHarness();
    handle.dispose();
    container.dispatch('touchstart', { touches: [{ clientX: 5, clientY: 300 }] });
    container.dispatch('touchmove', { touches: [{ clientX: 5, clientY: 200 }] });
    expect(container.listenerCount()).toBe(0);
  });
});
