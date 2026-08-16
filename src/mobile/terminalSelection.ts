/**
 * Mobile touch text selection for xterm.
 *
 * xterm's own selection is mouse-driven (mousedown + document mousemove);
 * touch drags are consumed by viewport scrolling, so drag-select never works
 * on Android WebView. This module adds the mobile pattern: long-press on text
 * selects the word, dragging extends/shrinks the range, lift keeps the
 * selection for the aux-bar copy button.
 *
 * Word boundaries are computed in CELL space (IBufferLine.getCell) so wide
 * chars (CJK/emoji) need no string-index conversion; term.select() also takes
 * cell units.
 */

import {
  bufferCoordsFromPoint,
  type BufferCoords,
  type CoordsFromPointOptions,
  type ScreenRectLike,
} from '@/lib/terminalCursorLocate';

export {
  bufferCoordsFromPoint,
  type BufferCoords,
  type CoordsFromPointOptions,
  type ScreenRectLike,
} from '@/lib/terminalCursorLocate';

/** xterm default wordSeparator: ' ()[]{}\',"`' — anything else is a word char. */
const WORD_SEPARATORS = new Set([
  ' ',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  "'",
  '"',
  '`',
]);

export function isWordChar(chars: string): boolean {
  if (!chars) return false;
  const ch = chars[0]!;
  return ch > ' ' && !WORD_SEPARATORS.has(ch);
}

/** Minimal IBufferLine surface we rely on (structural, for tests). */
export interface SelectionLine {
  getCell(
    x: number,
  ): { getChars(): string; getWidth(): number } | undefined;
}

export interface WordCellRange {
  /** inclusive start cell col */
  start: number;
  /** inclusive end cell col */
  end: number;
}

/**
 * Find the word around `col` in cell units. Tries the immediate left cell when
 * the finger lands just past a word's end (common on small cells).
 * Returns null when no word char is hit (blank area / separator).
 */
export function findWordCellRange(
  line: SelectionLine,
  col: number,
): WordCellRange | null {
  const cellChars = (x: number): string =>
    line.getCell(x)?.getChars() ?? '';
  let hit = col;
  if (!isWordChar(cellChars(hit))) {
    if (hit > 0 && isWordChar(cellChars(hit - 1))) {
      hit = hit - 1;
    } else {
      return null;
    }
  }
  let start = hit;
  let end = hit;
  while (start > 0 && isWordChar(cellChars(start - 1))) start--;
  while (isWordChar(cellChars(end + 1))) end++;
  return { start, end };
}

/** Ordered [start, end] (inclusive end) from a drag anchor + current point. */
export function dragSelectionRange(
  anchor: BufferCoords,
  current: BufferCoords,
  cols: number,
): { startCol: number; startLine: number; length: number } {
  const a = anchor.line * cols + anchor.col;
  const c = current.line * cols + current.col;
  const start = Math.min(a, c);
  const end = Math.max(a, c);
  return {
    startCol: start % cols,
    startLine: Math.floor(start / cols),
    length: end - start + 1,
  };
}

/** -1 = scroll toward older lines (finger at top), +1 = newer, 0 = none. */
export type EdgeScrollDir = -1 | 0 | 1;

/**
 * How far into the edge zone (0..1). Outside zone → 0.
 * Used to ramp scroll speed as the finger presses deeper into the edge.
 */
export function edgeScrollStrength(
  clientY: number,
  screenTop: number,
  screenBottom: number,
  edgeZonePx: number,
): { dir: EdgeScrollDir; strength: number } {
  if (edgeZonePx <= 0) return { dir: 0, strength: 0 };
  const topEdge = screenTop + edgeZonePx;
  if (clientY < topEdge) {
    const depth = Math.min(1, (topEdge - clientY) / edgeZonePx);
    return { dir: -1, strength: depth };
  }
  const bottomEdge = screenBottom - edgeZonePx;
  if (clientY > bottomEdge) {
    const depth = Math.min(1, (clientY - bottomEdge) / edgeZonePx);
    return { dir: 1, strength: depth };
  }
  return { dir: 0, strength: 0 };
}

/** Lines to scroll per tick from strength (1..maxLines). */
export function edgeScrollLinesPerTick(
  strength: number,
  maxLines = 3,
): number {
  if (strength <= 0) return 0;
  return Math.max(1, Math.ceil(strength * maxLines));
}

export interface SelectionTerminalLike {
  cols: number;
  rows: number;
  buffer: {
    active: {
      viewportY: number;
      getLine(y: number): SelectionLine | undefined;
    };
  };
  select(column: number, row: number, length: number): void;
  scrollLines(amount: number): void;
}

export interface TouchSelectionHandle {
  dispose: () => void;
  /** True while a long-press selection drag is in progress. */
  isSelecting: () => boolean;
}

export interface AttachTouchSelectionOptions {
  /** Element the terminal was opened into (contains .xterm-screen). */
  container: HTMLElement;
  getTerminal: () => SelectionTerminalLike | null;
  longPressMs?: number;
  /** px the finger may wander before the long-press is cancelled. */
  moveSlopPx?: number;
  /** Edge zone height for auto-scroll while dragging a selection. */
  edgeZonePx?: number;
  edgeScrollIntervalMs?: number;
  /** Fired once when a selection drag ends with an active selection. */
  onSelectionComplete?: () => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_LONG_PRESS_MS = 500;
const DEFAULT_MOVE_SLOP_PX = 10;
const DEFAULT_EDGE_ZONE_PX = 40;
const DEFAULT_EDGE_SCROLL_INTERVAL_MS = 50;

/**
 * Long-press → select word → drag to adjust → lift to keep. While selecting,
 * touchmove/touchend are intercepted in capture phase so xterm's viewport
 * scroll (and the momentum module) never see the gesture. Dragging into the
 * top/bottom edge slowly scrolls the buffer so long content can be selected.
 * Does not suppress the system context menu — the host may show a copy hint.
 */
export function attachTouchSelection(
  options: AttachTouchSelectionOptions,
): TouchSelectionHandle {
  const longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const moveSlop = options.moveSlopPx ?? DEFAULT_MOVE_SLOP_PX;
  const edgeZonePx = options.edgeZonePx ?? DEFAULT_EDGE_ZONE_PX;
  const edgeIntervalMs =
    options.edgeScrollIntervalMs ?? DEFAULT_EDGE_SCROLL_INTERVAL_MS;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;
  const setI = options.setIntervalFn ?? setInterval;
  const clearI = options.clearIntervalFn ?? clearInterval;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let edgeTimer: ReturnType<typeof setInterval> | null = null;
  let selecting = false;
  let startX = 0;
  let startY = 0;
  let lastClientX = 0;
  let lastClientY = 0;
  let anchor: BufferCoords | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  };

  const stopEdgeScroll = () => {
    if (edgeTimer !== null) {
      clearI(edgeTimer);
      edgeTimer = null;
    }
  };

  const screenEl = (): HTMLElement | null =>
    options.container.querySelector('.xterm-screen');

  const coordsFromTouch = (
    touch: { clientX: number; clientY: number },
    clamp: boolean,
  ): BufferCoords | null => {
    const term = options.getTerminal();
    const screen = screenEl();
    if (!term || !screen) return null;
    return bufferCoordsFromPoint(
      touch.clientX,
      touch.clientY,
      screen.getBoundingClientRect(),
      term.cols,
      term.rows,
      term.buffer.active.viewportY,
      { clamp },
    );
  };

  const applyDrag = (current: BufferCoords) => {
    const term = options.getTerminal();
    if (!term || !anchor) return;
    const range = dragSelectionRange(anchor, current, term.cols);
    term.select(range.startCol, range.startLine, range.length);
  };

  const tickEdgeScroll = () => {
    if (!selecting) {
      stopEdgeScroll();
      return;
    }
    const term = options.getTerminal();
    const screen = screenEl();
    if (!term || !screen) return;
    const rect = screen.getBoundingClientRect();
    const { dir, strength } = edgeScrollStrength(
      lastClientY,
      rect.top,
      rect.bottom,
      edgeZonePx,
    );
    const lines = edgeScrollLinesPerTick(strength);
    if (dir === 0 || lines === 0) return;
    const before = term.buffer.active.viewportY;
    term.scrollLines(dir * lines);
    if (term.buffer.active.viewportY === before) return;
    const coords = coordsFromTouch(
      { clientX: lastClientX, clientY: lastClientY },
      true,
    );
    if (coords) applyDrag(coords);
  };

  const ensureEdgeScroll = () => {
    if (edgeTimer !== null) return;
    edgeTimer = setI(tickEdgeScroll, edgeIntervalMs);
  };

  const beginSelection = () => {
    const term = options.getTerminal();
    if (!term) return;
    const coords = coordsFromTouch(
      { clientX: startX, clientY: startY },
      false,
    );
    if (!coords) return;
    const line = term.buffer.active.getLine(coords.line);
    if (!line) return;
    const word = findWordCellRange(line, coords.col);
    if (!word) return;
    selecting = true;
    lastClientX = startX;
    lastClientY = startY;
    anchor = { col: word.start, line: coords.line };
    term.select(word.start, coords.line, word.end - word.start + 1);
    ensureEdgeScroll();
  };

  const endSelectingGesture = (completed: boolean) => {
    const wasSelecting = selecting;
    cancelTimer();
    stopEdgeScroll();
    selecting = false;
    anchor = null;
    if (wasSelecting && completed) {
      options.onSelectionComplete?.();
    }
  };

  const onTouchStart = (ev: TouchEvent) => {
    endSelectingGesture(false);
    if (ev.touches.length !== 1) return;
    const touch = ev.touches[0]!;
    startX = touch.clientX;
    startY = touch.clientY;
    lastClientX = startX;
    lastClientY = startY;
    timer = setT(beginSelection, longPressMs);
  };

  // Capture phase: must run before xterm's own listener on .xterm.
  const onTouchMove = (ev: TouchEvent) => {
    if (selecting) {
      if (ev.touches.length !== 1) return;
      const touch = ev.touches[0]!;
      lastClientX = touch.clientX;
      lastClientY = touch.clientY;
      const coords = coordsFromTouch(touch, true);
      if (coords) applyDrag(coords);
      ensureEdgeScroll();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (timer !== null && ev.touches.length === 1) {
      const touch = ev.touches[0]!;
      if (
        Math.abs(touch.clientX - startX) > moveSlop ||
        Math.abs(touch.clientY - startY) > moveSlop
      ) {
        cancelTimer();
      }
    }
  };

  const onTouchEnd = (ev: TouchEvent) => {
    if (selecting && ev.touches.length === 0) {
      endSelectingGesture(true);
      // Keep the selection; block momentum fling / stray handlers.
      ev.stopPropagation();
      return;
    }
    cancelTimer();
  };

  const onTouchCancel = () => {
    endSelectingGesture(false);
  };

  const el = options.container;
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  el.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return {
    isSelecting: () => selecting,
    dispose: () => {
      endSelectingGesture(false);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      el.removeEventListener('touchcancel', onTouchCancel);
    },
  };
}
