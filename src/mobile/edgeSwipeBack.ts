/**
 * In-app edge swipe for "back" (a pure feature: finger in, intent out).
 *
 * Why this exists: on some ROMs (HyperOS among them) the system back gesture
 * never reports its progress to the app — only the final "commit" arrives — so
 * a preview that waits for the system never moves. Native apps that animate
 * back on those phones track the finger themselves (dsh-Go keeps a strip along
 * the leading edge for exactly this). This file is that strip, minus the strip:
 *
 * - Listens on `document`, so nothing is covered and taps/clicks near the edge
 *   behave as always. Only a touch that **starts within {@link EDGE_PX} of a
 *   screen edge** and then **moves inward** becomes a back swipe; everything
 *   else (vertical scrolls, horizontal gestures in the middle) is untouched.
 * - Knows nothing about layers: it reports finger progress to `touchBack`
 *   (backHandler.ts), which drives the topmost layer's preview and, on
 *   release, closes it through the same path the system's commit uses.
 * - If the system also takes the swipe (it steals the finger at the very edge
 *   and sends `touchcancel`), the engine hands over to the system's events or
 *   waits briefly for its commit — see `touchBack.drop`.
 *
 * Caveat worth knowing: on gesture navigation the system owns the outermost
 * strip of the screen. A swipe that starts inside it is the system's; one that
 * starts a little further in (still within {@link EDGE_PX}) is ours, in full.
 */

import { subscribeBackDiagnostics, touchBack, getBackDiagnostics } from './backHandler';
import type { BackEdge } from './backHandler';

/** Touches starting this close to a screen edge may become a back swipe (CSS px). */
export const EDGE_PX = 44;
/** Inward travel before we commit to the swipe; vertical-dominant moves bail out. */
const SLOP_PX = 8;
/** Horizontal must beat vertical by this factor, so a diagonal scroll isn't hijacked. */
const HORIZONTAL_DOMINANCE = 1.2;
/** Release past this fraction of the screen width commits. */
const COMMIT_PROGRESS = 0.28;
/** Or flick inward faster than this many screen widths per second. */
const COMMIT_FLING = 1.1;
/** Velocity window. */
const VELOCITY_WINDOW_MS = 50;

interface Track {
  id: number;
  edge: BackEdge;
  x0: number;
  y0: number;
  started: boolean;
  samples: Array<{ x: number; t: number }>;
}

let track: Track | null = null;

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

/** Inward travel in px (positive = toward the screen centre). */
function inward(t: Track, x: number): number {
  return t.edge === 'left' ? x - t.x0 : t.x0 - x;
}

function onTouchStart(e: TouchEvent): void {
  if (track || e.touches.length !== 1) return;
  if (!touchBack.canStart()) return;
  const touch = e.touches[0];
  const width = window.innerWidth;
  const edge: BackEdge | null =
    touch.clientX <= EDGE_PX ? 'left' : touch.clientX >= width - EDGE_PX ? 'right' : null;
  if (!edge) return;
  // Opt-out for content that owns horizontal drags at the edge.
  const target = e.target;
  if (target instanceof Element && target.closest('[data-no-edge-swipe]')) return;
  track = {
    id: touch.identifier,
    edge,
    x0: touch.clientX,
    y0: touch.clientY,
    started: false,
    samples: [{ x: touch.clientX, t: e.timeStamp }],
  };
}

function onTouchMove(e: TouchEvent): void {
  const t = track;
  if (!t) return;
  const touch = findTouch(e.touches, t.id);
  if (!touch) return;
  const dx = inward(t, touch.clientX);
  const dy = touch.clientY - t.y0;

  if (!t.started) {
    if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
    const horizontal = dx >= SLOP_PX && dx > Math.abs(dy) * HORIZONTAL_DOMINANCE;
    if (!horizontal || !touchBack.begin(t.edge, touch.clientY)) {
      track = null; // a scroll or something else: not ours
      return;
    }
    t.started = true;
  }

  // From the first inward move on this finger is ours: stop the page scrolling
  // under it. (Only possible before the browser starts a scroll, which is why
  // the decision above happens on the very first move past the slop.)
  if (e.cancelable) e.preventDefault();

  t.samples.push({ x: touch.clientX, t: e.timeStamp });
  // Keep a short tail only: older samples can never fall inside the window.
  if (t.samples.length > 12) t.samples.splice(0, t.samples.length - 12);

  touchBack.move(Math.min(Math.max(dx / window.innerWidth, 0), 1), touch.clientY);
}

/**
 * Inward velocity in screen widths per second over the last
 * {@link VELOCITY_WINDOW_MS} before the finger lifted. `endX` / `endT` is the
 * lift itself, so a finger that stopped and then lifted reads as zero rather
 * than as whatever speed it had before it paused.
 */
function flingVelocity(t: Track, endX: number, endT: number): number {
  const cutoff = endT - VELOCITY_WINDOW_MS;
  const recent = t.samples.filter((s) => s.t >= cutoff);
  const first = recent[0];
  if (!first) return 0;
  const dt = endT - first.t;
  if (dt <= 0) return 0;
  const dx = t.edge === 'left' ? endX - first.x : first.x - endX;
  return (dx / dt) * (1000 / window.innerWidth);
}

function onTouchEnd(e: TouchEvent): void {
  const t = track;
  if (!t) return;
  const touch = findTouch(e.changedTouches, t.id);
  if (!touch) return;
  track = null;
  if (!t.started) return;
  const progress = Math.max(inward(t, touch.clientX), 0) / window.innerWidth;
  const v = flingVelocity(t, touch.clientX, e.timeStamp);
  // Past the line, or flicked inward — unless the finger was clearly heading back.
  const commit = (progress >= COMMIT_PROGRESS && v > -0.4) || v >= COMMIT_FLING;
  touchBack.end(commit);
}

function onTouchCancel(e: TouchEvent): void {
  const t = track;
  if (!t) return;
  if (!findTouch(e.changedTouches, t.id)) return;
  track = null;
  if (t.started) touchBack.drop();
}

/**
 * Start listening. Returns the uninstall function.
 *
 * `touchmove` has to be a non-passive listener (to stop the scroll under an
 * edge swipe), and a non-passive document-level listener makes the browser wait
 * for the main thread before it starts any scroll. So it is only attached while
 * some layer is registered — the only time a back swipe has anything to do.
 */
export function installEdgeSwipeBack(): () => void {
  const opts = { capture: true, passive: true } as const;
  document.addEventListener('touchstart', onTouchStart, opts);
  document.addEventListener('touchend', onTouchEnd, opts);
  document.addEventListener('touchcancel', onTouchCancel, opts);

  let moveAttached = false;
  const syncMove = () => {
    const want = getBackDiagnostics().stackDepth > 0;
    if (want === moveAttached) return;
    moveAttached = want;
    if (want) {
      document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    } else {
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
    }
  };
  syncMove();
  const unsubscribe = subscribeBackDiagnostics(syncMove);

  return () => {
    unsubscribe();
    document.removeEventListener('touchstart', onTouchStart, { capture: true });
    document.removeEventListener('touchend', onTouchEnd, { capture: true });
    document.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    document.removeEventListener('touchmove', onTouchMove, { capture: true });
    moveAttached = false;
    track = null;
  };
}
