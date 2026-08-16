/**
 * Click-to-position the terminal cursor (desktop).
 *
 * Mouse counterpart of the mobile tap-to-locate (terminalTapLocate): a left
 * click on the cursor's on-screen row sends arrow-key sequences that move the
 * remote shell cursor to the clicked cell. Cross-row clicks are ignored —
 * ↑/↓ would hit shell history or program bindings — and when the remote app
 * has enabled mouse tracking (vim/htop/tmux) the click is left entirely to
 * xterm's mouse protocol, so the app sees it instead of a conflicting arrow
 * key. Dragging (text selection) is never treated as a click.
 */

import {
  bufferCoordsFromPoint,
  isScreenHoveringLink,
  resolveTapLocateSequence,
} from '@/lib/terminalCursorLocate';

export interface ClickLocateTerminalLike {
  cols: number;
  rows: number;
  modes: {
    /** xterm: 'none' unless the remote app enabled mouse reporting. */
    mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  };
  buffer: {
    active: {
      viewportY: number;
      cursorX: number;
      cursorY: number;
    };
  };
}

export interface ClickLocateHandle {
  dispose: () => void;
}

export interface AttachClickLocateOptions {
  container: HTMLElement;
  getTerminal: () => ClickLocateTerminalLike | null;
  /** Fired with the arrow sequence once a same-row click is resolved. */
  onLocate: (sequence: string) => void;
  /** Movement slop in px — beyond this the gesture is a drag (selection). */
  moveSlopPx?: number;
}

const DEFAULT_MOVE_SLOP_PX = 5;

export function attachClickLocate(
  options: AttachClickLocateOptions,
): ClickLocateHandle {
  const moveSlopPx = options.moveSlopPx ?? DEFAULT_MOVE_SLOP_PX;

  let startX = 0;
  let startY = 0;
  let tracking = false;
  let moved = false;

  const screenEl = (): HTMLElement | null =>
    options.container.querySelector('.xterm-screen');

  const onMouseDown = (ev: MouseEvent) => {
    // Left button only; modifier clicks are kept for other purposes.
    if (
      ev.button !== 0 ||
      ev.ctrlKey ||
      ev.altKey ||
      ev.metaKey ||
      ev.shiftKey
    ) {
      tracking = false;
      return;
    }
    startX = ev.clientX;
    startY = ev.clientY;
    tracking = true;
    moved = false;
  };

  const onMouseMove = (ev: MouseEvent) => {
    if (!tracking || moved) return;
    if (
      Math.abs(ev.clientX - startX) > moveSlopPx ||
      Math.abs(ev.clientY - startY) > moveSlopPx
    ) {
      moved = true;
    }
  };

  const onMouseUp = (ev: MouseEvent) => {
    if (!tracking) return;
    tracking = false;
    if (moved || ev.button !== 0) return;
    const term = options.getTerminal();
    const screen = screenEl();
    if (!term || !screen) return;
    // Clicking a link opens it (WebLinksAddon) — don't also move the cursor.
    if (isScreenHoveringLink(screen)) return;
    // Remote app owns mouse input (vim/htop/tmux): xterm already forwarded the
    // click via its mouse protocol; sending arrow keys too would conflict.
    if (term.modes.mouseTrackingMode !== 'none') return;
    const tapped = bufferCoordsFromPoint(
      ev.clientX,
      ev.clientY,
      screen.getBoundingClientRect(),
      term.cols,
      term.rows,
      term.buffer.active.viewportY,
    );
    if (!tapped) return;
    const seq = resolveTapLocateSequence(
      term.buffer.active.cursorX,
      term.buffer.active.cursorY,
      term.buffer.active.viewportY,
      tapped,
    );
    if (seq) options.onLocate(seq);
  };

  const el = options.container;
  el.addEventListener('mousedown', onMouseDown);
  // Track release outside the container (drag started inside, ended outside).
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  return {
    dispose: () => {
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    },
  };
}
