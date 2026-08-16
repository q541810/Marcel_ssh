// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  attachClickLocate,
  type ClickLocateTerminalLike,
} from './terminalClickLocate';

function makeTerminal(
  overrides: Partial<ClickLocateTerminalLike> = {},
): ClickLocateTerminalLike {
  return {
    cols: 80,
    rows: 24,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { viewportY: 0, cursorX: 10, cursorY: 5 } },
    ...overrides,
  };
}

function setup(term: ClickLocateTerminalLike = makeTerminal()) {
  const container = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  // cellW = 800/80 = 10, cellH = 240/24 = 10
  screen.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 800,
      height: 240,
      right: 800,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  container.appendChild(screen);
  const sent: string[] = [];
  const handle = attachClickLocate({
    container,
    getTerminal: () => term,
    onLocate: (s) => sent.push(s),
  });
  return { container, screen, sent, handle };
}

/** Click at a client point on the cursor row (col 10, row 5). */
function clickAt(
  el: HTMLElement,
  x: number,
  y: number,
  init: MouseEventInit = {},
) {
  el.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      ...init,
    }),
  );
  document.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      ...init,
    }),
  );
}

describe('attachClickLocate', () => {
  it('moves right when clicking a cell to the right of the cursor', () => {
    const { container, sent } = setup();
    // col 12 → 2 cells right of cursor col 10 (cursor row 5 → y=55).
    clickAt(container, 125, 55);
    expect(sent).toEqual(['\x1b[C'.repeat(2)]);
  });

  it('moves left when clicking a cell to the left of the cursor', () => {
    const { container, sent } = setup();
    clickAt(container, 55, 55); // col 5 → 5 cells left
    expect(sent).toEqual(['\x1b[D'.repeat(5)]);
  });

  it('does nothing when clicking the cursor cell', () => {
    const { container, sent } = setup();
    clickAt(container, 105, 55); // col 10
    expect(sent).toEqual([]);
  });

  it('does nothing when clicking another row (history / program risk)', () => {
    const { container, sent } = setup();
    clickAt(container, 125, 25); // row 2, not the cursor row 5
    expect(sent).toEqual([]);
  });

  it('does nothing after dragging (text selection)', () => {
    const { container, sent } = setup();
    container.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 125, clientY: 55 }),
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 80 }),
    );
    document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 200, clientY: 80 }),
    );
    expect(sent).toEqual([]);
  });

  it('does nothing when the app enabled mouse tracking (vim/htop/tmux)', () => {
    const { container, sent } = setup(
      makeTerminal({ modes: { mouseTrackingMode: 'drag' } }),
    );
    clickAt(container, 125, 55);
    expect(sent).toEqual([]);
  });

  it('does nothing when clicking a link (xterm-cursor-pointer hover)', () => {
    const { container, screen, sent } = setup();
    screen.classList.add('xterm-cursor-pointer');
    clickAt(container, 125, 55);
    expect(sent).toEqual([]);
  });

  it('does nothing on modifier clicks', () => {
    const { container, sent } = setup();
    clickAt(container, 125, 55, { ctrlKey: true });
    clickAt(container, 125, 55, { shiftKey: true });
    expect(sent).toEqual([]);
  });

  it('does nothing on non-left buttons', () => {
    const { container, sent } = setup();
    clickAt(container, 125, 55, { button: 2 });
    expect(sent).toEqual([]);
  });

  it('stops locating after dispose', () => {
    const { container, sent, handle } = setup();
    handle.dispose();
    clickAt(container, 125, 55);
    expect(sent).toEqual([]);
  });

  it('uses the current terminal state at mouseup time', () => {
    const term = makeTerminal();
    const { container, sent } = setup(term);
    container.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 125, clientY: 55 }),
    );
    // Cursor moves between down and up → sequence resolves against the new state.
    term.buffer.active.cursorX = 12;
    document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 125, clientY: 55 }),
    );
    expect(sent).toEqual([]); // now the same cell → no movement
  });

  it('ignores a mousedown followed by mouseup outside the terminal', () => {
    const { container, sent } = setup();
    container.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 125, clientY: 55 }),
    );
    document.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 4000, clientY: 4000 }),
    );
    expect(sent).toEqual([]); // outside screen → bufferCoordsFromPoint null
  });
});
