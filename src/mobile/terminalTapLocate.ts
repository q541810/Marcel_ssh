/**
 * Tap-to-position the terminal cursor (mobile).
 *
 * The SSH cursor lives in the remote shell (readline): a tap can only be
 * translated into arrow-key sequences. ↑/↓ across lines would hit shell
 * history or program bindings (vim/less…), so positioning is restricted to
 * the SAME on-screen row as the cursor — tapping anywhere else just focuses
 * the terminal. The mapping logic lives in the shared
 * `@/lib/terminalCursorLocate` module (also used by desktop click-to-locate).
 */

import {
  bufferCoordsFromPoint,
  isScreenHoveringLink,
  resolveTapLocateSequence,
  type TapLocatePoint,
} from '@/lib/terminalCursorLocate';

export {
  resolveTapLocateSequence,
  type TapLocatePoint,
} from '@/lib/terminalCursorLocate';

export interface TapLocateTerminalLike {
  cols: number;
  rows: number;
  buffer: {
    active: {
      viewportY: number;
      cursorX: number;
      cursorY: number;
    };
  };
}

export interface TapLocateHandle {
  dispose: () => void;
}

export interface AttachTapLocateOptions {
  container: HTMLElement;
  getTerminal: () => TapLocateTerminalLike | null;
  /** Fired with the arrow sequence once a same-row tap is resolved. */
  onLocate: (sequence: string) => void;
  /** Aligns with attachTouchSelection's long-press threshold (500). */
  longPressMs?: number;
  /** Movement slop in px — beyond this the touch is a scroll, not a tap. */
  moveSlopPx?: number;
  now?: () => number;
}

const DEFAULT_LONG_PRESS_MS = 500;
const DEFAULT_MOVE_SLOP_PX = 10;

/**
 * Tap gesture recognizer, independent from selection (long-press) and
 * momentum (scroll): a touch that stays still and lifts before the long-press
 * threshold is a tap. Lives in the bubble phase, so a selection drag that
 * calls stopPropagation in the capture phase (touchSelection) skips it.
 */
export function attachTapLocate(
  options: AttachTapLocateOptions,
): TapLocateHandle {
  const longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const moveSlopPx = options.moveSlopPx ?? DEFAULT_MOVE_SLOP_PX;
  const now = options.now ?? (() => performance.now());

  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let moved = false;

  const screenEl = (): HTMLElement | null =>
    options.container.querySelector('.xterm-screen');

  const onTouchStart = (ev: TouchEvent) => {
    if (ev.touches.length !== 1) {
      moved = true; // multi-touch is never a tap
      return;
    }
    const touch = ev.touches[0]!;
    startX = touch.clientX;
    startY = touch.clientY;
    startTime = now();
    moved = false;
  };

  const onTouchMove = (ev: TouchEvent) => {
    if (moved || ev.touches.length !== 1) return;
    const touch = ev.touches[0]!;
    if (
      Math.abs(touch.clientX - startX) > moveSlopPx ||
      Math.abs(touch.clientY - startY) > moveSlopPx
    ) {
      moved = true;
    }
  };

  const onTouchCancel = () => {
    moved = true;
  };

  const onTouchEnd = (ev: TouchEvent) => {
    if (moved || ev.touches.length !== 0) return;
    if (now() - startTime >= longPressMs) return; // long-press → selection path
    const term = options.getTerminal();
    const screen = screenEl();
    const touch = ev.changedTouches[0];
    if (!term || !screen || !touch) return;
    // Tapping a link opens it (WebLinksAddon) — don't also move the cursor.
    if (isScreenHoveringLink(screen)) return;
    const tapped = bufferCoordsFromPoint(
      touch.clientX,
      touch.clientY,
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
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return {
    dispose: () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    },
  };
}
