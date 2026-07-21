import { describe, it, expect, vi } from 'vitest';
import {
  attachTouchSelection,
  bufferCoordsFromPoint,
  dragSelectionRange,
  edgeScrollLinesPerTick,
  edgeScrollStrength,
  findWordCellRange,
  isWordChar,
  type SelectionLine,
} from './terminalSelection';

function lineFromText(text: string): SelectionLine {
  return {
    getCell(x: number) {
      if (x < 0 || x >= text.length) return undefined;
      return { getChars: () => text[x]!, getWidth: () => 1 };
    },
  };
}

describe('isWordChar', () => {
  it('accepts letters, digits, path chars', () => {
    for (const ch of ['a', 'Z', '0', '/', '.', '-', '_', '~', '中']) {
      expect(isWordChar(ch)).toBe(true);
    }
  });
  it('rejects whitespace and xterm default separators', () => {
    for (const ch of [' ', '(', ')', '[', ']', '{', '}', "'", '"', '`']) {
      expect(isWordChar(ch)).toBe(false);
    }
  });
  it('rejects empty (null cell after wide char)', () => {
    expect(isWordChar('')).toBe(false);
  });
});

describe('findWordCellRange', () => {
  it('expands around a hit inside a word', () => {
    const line = lineFromText('cd /usr/local/bin && ls');
    //             0123456789...
    // hit 's' of /usr/local/bin (col 5)
    expect(findWordCellRange(line, 5)).toEqual({ start: 3, end: 16 });
  });

  it('hits single-char word', () => {
    const line = lineFromText('a b c');
    expect(findWordCellRange(line, 2)).toEqual({ start: 2, end: 2 });
  });

  it('snaps to the left word from a single gap cell', () => {
    const line = lineFromText('foo bar');
    // col 3 is the space; left neighbor 'o' is word → selects foo
    expect(findWordCellRange(line, 3)).toEqual({ start: 0, end: 2 });
  });

  it('returns null when neither the cell nor its left neighbor is a word', () => {
    const line = lineFromText('foo  bar');
    // col 4 is the second space; left neighbor is also space
    expect(findWordCellRange(line, 4)).toBeNull();
  });

  it('returns null on empty line', () => {
    expect(findWordCellRange(lineFromText(''), 0)).toBeNull();
  });

  it('stops at separators', () => {
    const line = lineFromText('key=[value]');
    expect(findWordCellRange(line, 1)).toEqual({ start: 0, end: 3 });
    expect(findWordCellRange(line, 6)).toEqual({ start: 5, end: 9 });
  });
});

describe('bufferCoordsFromPoint', () => {
  const screen = { left: 10, top: 20, width: 800, height: 400 };

  it('maps point to col/line with scrollback offset', () => {
    // cellW = 800/80 = 10, cellH = 400/20 = 20
    expect(bufferCoordsFromPoint(15, 25, screen, 80, 20, 100)).toEqual({
      col: 0,
      line: 100,
    });
    expect(bufferCoordsFromPoint(809, 419, screen, 80, 20, 100)).toEqual({
      col: 79,
      line: 119,
    });
  });

  it('returns null outside the screen', () => {
    expect(bufferCoordsFromPoint(9, 25, screen, 80, 20, 0)).toBeNull();
    expect(bufferCoordsFromPoint(15, 19, screen, 80, 20, 0)).toBeNull();
    expect(bufferCoordsFromPoint(811, 25, screen, 80, 20, 0)).toBeNull();
    expect(bufferCoordsFromPoint(15, 421, screen, 80, 20, 0)).toBeNull();
  });

  it('returns null on degenerate geometry', () => {
    expect(
      bufferCoordsFromPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 80, 20, 0),
    ).toBeNull();
  });

  it('clamps outside points when clamp is on', () => {
    expect(
      bufferCoordsFromPoint(9, 19, screen, 80, 20, 100, { clamp: true }),
    ).toEqual({ col: 0, line: 100 });
    expect(
      bufferCoordsFromPoint(900, 500, screen, 80, 20, 100, { clamp: true }),
    ).toEqual({ col: 79, line: 119 });
  });
});

describe('edgeScrollStrength / edgeScrollLinesPerTick', () => {
  it('detects top and bottom edge zones', () => {
    // screen 0..400, zone 40
    const top = edgeScrollStrength(10, 0, 400, 40);
    expect(top.dir).toBe(-1);
    expect(top.strength).toBeCloseTo(0.75, 5);
    expect(edgeScrollStrength(390, 0, 400, 40).dir).toBe(1);
    expect(edgeScrollStrength(200, 0, 400, 40)).toEqual({ dir: 0, strength: 0 });
  });

  it('maps strength to at least one line', () => {
    expect(edgeScrollLinesPerTick(0)).toBe(0);
    expect(edgeScrollLinesPerTick(0.1)).toBe(1);
    expect(edgeScrollLinesPerTick(1, 3)).toBe(3);
  });
});

describe('dragSelectionRange', () => {
  it('forward drag on one line', () => {
    expect(
      dragSelectionRange({ col: 2, line: 5 }, { col: 7, line: 5 }, 80),
    ).toEqual({ startCol: 2, startLine: 5, length: 6 });
  });

  it('backward drag swaps order', () => {
    expect(
      dragSelectionRange({ col: 7, line: 5 }, { col: 2, line: 5 }, 80),
    ).toEqual({ startCol: 2, startLine: 5, length: 6 });
  });

  it('multi-line forward', () => {
    // start 2*80+10=170, end 4*80+5=325 → length 156
    expect(
      dragSelectionRange({ col: 10, line: 2 }, { col: 5, line: 4 }, 80),
    ).toEqual({ startCol: 10, startLine: 2, length: 156 });
  });

  it('multi-line backward', () => {
    expect(
      dragSelectionRange({ col: 5, line: 4 }, { col: 10, line: 2 }, 80),
    ).toEqual({ startCol: 10, startLine: 2, length: 156 });
  });
});

describe('attachTouchSelection', () => {
  function makeHarness(text: string) {
    type Listener = (ev: any) => void;
    const listeners = new Map<string, { fn: Listener; capture: boolean }[]>();
    const screen = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 400,
        width: 800,
        height: 400,
      }),
    };
    const container = {
      querySelector: (sel: string) => (sel === '.xterm-screen' ? screen : null),
      addEventListener(type: string, fn: Listener, opts?: any) {
        const arr = listeners.get(type) ?? [];
        arr.push({ fn, capture: !!opts?.capture });
        listeners.set(type, arr);
      },
      removeEventListener(type: string, fn: Listener) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((l) => l.fn !== fn),
        );
      },
      dispatch(type: string, ev: any) {
        const arr = listeners.get(type) ?? [];
        // DOM order on one element: capture listeners, then bubble listeners.
        for (const l of arr.filter((x) => x.capture)) l.fn(ev);
        for (const l of arr.filter((x) => !x.capture)) l.fn(ev);
      },
    };

    const select = vi.fn();
    const scrollLines = vi.fn();
    let viewportY = 0;
    const term = {
      cols: 80,
      rows: 20,
      buffer: {
        active: {
          get viewportY() {
            return viewportY;
          },
          getLine: (_y: number) => lineFromText(text),
        },
      },
      select,
      scrollLines: (n: number) => {
        viewportY += n;
        scrollLines(n);
      },
    };

    const onSelectionComplete = vi.fn();
    let edgeTick: (() => void) | null = null;
    vi.useFakeTimers();
    const handle = attachTouchSelection({
      container: container as unknown as HTMLElement,
      getTerminal: () => term,
      longPressMs: 500,
      edgeScrollIntervalMs: 50,
      edgeZonePx: 40,
      onSelectionComplete,
      // Capture interval callback so tests can tick without relying on fake-timer
      // setInterval integration quirks.
      setIntervalFn: ((fn: TimerHandler) => {
        edgeTick = fn as () => void;
        return 99 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {
        edgeTick = null;
      }) as typeof clearInterval,
    });

    const touch = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
    });
    const fire = (type: string, t: { x: number; y: number }) => {
      const ev = {
        touches: type === 'touchend' ? [] : [touch(t.x, t.y)],
        changedTouches: [touch(t.x, t.y)],
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      container.dispatch(type, ev);
      return ev;
    };

    return {
      handle,
      select,
      scrollLines,
      onSelectionComplete,
      fire,
      runEdgeTick: () => edgeTick?.(),
    };
  }

  it('long-press on a word selects it', () => {
    const { handle, select, fire } = makeHarness('cd /usr/local/bin && ls');
    fire('touchstart', { x: 55, y: 10 }); // col 5, row 0
    vi.advanceTimersByTime(600);
    expect(select).toHaveBeenCalledWith(3, 0, 14);
    expect(handle.isSelecting()).toBe(true);
    handle.dispose();
    vi.useRealTimers();
  });

  it('long-press on blank does nothing', () => {
    const { handle, select, fire } = makeHarness('foo');
    fire('touchstart', { x: 300, y: 10 });
    vi.advanceTimersByTime(600);
    expect(select).not.toHaveBeenCalled();
    expect(handle.isSelecting()).toBe(false);
    handle.dispose();
    vi.useRealTimers();
  });

  it('moving before the delay cancels the long-press', () => {
    const { handle, select, fire } = makeHarness('cd /usr/local/bin && ls');
    fire('touchstart', { x: 55, y: 10 });
    fire('touchmove', { x: 55, y: 40 });
    vi.advanceTimersByTime(600);
    expect(select).not.toHaveBeenCalled();
    expect(handle.isSelecting()).toBe(false);
    handle.dispose();
    vi.useRealTimers();
  });

  it('dragging after long-press extends the selection and intercepts', () => {
    const { handle, select, fire } = makeHarness('cd /usr/local/bin && ls');
    fire('touchstart', { x: 55, y: 10 });
    vi.advanceTimersByTime(600);
    select.mockClear();
    const ev = fire('touchmove', { x: 5, y: 10 }); // drag to col 0
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();
    // anchor = word start (3,0); current (0,0) → range 0..3
    expect(select).toHaveBeenCalledWith(0, 0, 4);
    handle.dispose();
    vi.useRealTimers();
  });

  it('lift keeps selection state but ends selecting mode', () => {
    const { handle, fire, onSelectionComplete } = makeHarness(
      'cd /usr/local/bin && ls',
    );
    fire('touchstart', { x: 55, y: 10 });
    vi.advanceTimersByTime(600);
    const ev = fire('touchend', { x: 55, y: 10 });
    expect(ev.stopPropagation).toHaveBeenCalled();
    expect(handle.isSelecting()).toBe(false);
    expect(onSelectionComplete).toHaveBeenCalledTimes(1);
    handle.dispose();
    vi.useRealTimers();
  });

  it('edge-drags slowly scroll the viewport while selecting', () => {
    const { handle, scrollLines, select, fire, runEdgeTick } = makeHarness(
      'cd /usr/local/bin && ls',
    );
    // Long-press already in the bottom edge zone so auto-scroll engages.
    fire('touchstart', { x: 55, y: 390 });
    vi.advanceTimersByTime(600);
    expect(select).toHaveBeenCalled();
    expect(handle.isSelecting()).toBe(true);
    scrollLines.mockClear();
    runEdgeTick();
    expect(scrollLines.mock.calls.length).toBeGreaterThan(0);
    expect(scrollLines.mock.calls.some(([n]) => n > 0)).toBe(true);
    handle.dispose();
    vi.useRealTimers();
  });
});
