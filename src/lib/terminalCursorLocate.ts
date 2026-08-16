/**
 * Cursor-locate-by-point for terminal screens (shared mobile / desktop).
 *
 * The SSH cursor lives in the remote shell (readline): a tap/click can only
 * be translated into arrow-key sequences. ↑/↓ across lines would hit shell
 * history or program bindings (vim/less…), so positioning is restricted to
 * the SAME on-screen row as the cursor — tapping/clicking anywhere else only
 * focuses the terminal. Sequences repeat single arrow keys (`\x1b[D\x1b[D…`)
 * instead of CSI-n parameters (`\x1b[2D`) because readline only binds the
 * exact ESC [ A/B/C/D byte sequences.
 */

export interface ScreenRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BufferCoords {
  /** cell column, 0..cols-1 */
  col: number;
  /** absolute buffer line (includes scrollback) */
  line: number;
}

export interface CoordsFromPointOptions {
  /** Clamp to screen instead of returning null when outside (edge-drag). */
  clamp?: boolean;
}

/** Map a client point to buffer coords; null when outside (unless clamp). */
export function bufferCoordsFromPoint(
  clientX: number,
  clientY: number,
  screen: ScreenRectLike,
  cols: number,
  rows: number,
  viewportY: number,
  options?: CoordsFromPointOptions,
): BufferCoords | null {
  if (screen.width <= 0 || screen.height <= 0 || cols <= 0 || rows <= 0) {
    return null;
  }
  const cellW = screen.width / cols;
  const cellH = screen.height / rows;
  let col = Math.floor((clientX - screen.left) / cellW);
  let row = Math.floor((clientY - screen.top) / cellH);
  if (options?.clamp) {
    col = Math.max(0, Math.min(cols - 1, col));
    row = Math.max(0, Math.min(rows - 1, row));
    return { col, line: viewportY + row };
  }
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, line: viewportY + row };
}

export interface TapLocatePoint {
  col: number;
  /** Absolute buffer line (viewportY + on-screen row). */
  line: number;
}

/**
 * Map a tap/click to an arrow-key sequence that moves the cursor to the
 * pointed cell. Returns null when the point is outside the cursor's screen
 * row (cross-line arrows are unsafe: they hit shell history / program
 * bindings) or on the cursor itself.
 */
export function resolveTapLocateSequence(
  cursorX: number,
  cursorY: number,
  viewportY: number,
  tapped: TapLocatePoint,
): string | null {
  if (tapped.line !== viewportY + cursorY) return null;
  const delta = tapped.col - cursorX;
  if (delta === 0) return null;
  return delta > 0 ? '\x1b[C'.repeat(delta) : '\x1b[D'.repeat(-delta);
}

/**
 * xterm marks its screen element with `xterm-cursor-pointer` while the
 * pointer hovers a link. When a tap/click lands on a link the locate logic
 * must stand down: the link activation (open in browser) must not be joined
 * by a conflicting arrow-key sequence.
 */
export function isScreenHoveringLink(screen: HTMLElement | null): boolean {
  return !!screen?.classList.contains('xterm-cursor-pointer');
}
