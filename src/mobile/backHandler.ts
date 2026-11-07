/**
 * Android back-gesture handler for the mobile shell.
 *
 * Two halves, both driven by MainActivity:
 *
 * 1. **Commit** — `window.__marcelHandleBack()` runs when the user finishes a
 *    back gesture (or presses the back button). Returning true means the web
 *    layer consumed it (a sheet closed, a sub-page popped); false lets the
 *    system finish the activity.
 *
 * 2. **Predictive back (preview)** — on Android 14+ the system reports the
 *    gesture while the finger is still down: `__marcelBackStart` →
 *    `__marcelBackProgress`* → `__marcelBackCancel` (or the commit above). The
 *    topmost layer may supply a {@link BackPreview} that follows the finger, so
 *    the user sees where the gesture will land before letting go. Older systems
 *    only ever deliver the commit, so previews are purely additive.
 *
 * 3. **In-app edge swipe** — some ROMs (HyperOS among them) never report the
 *    gesture, only the final commit. `edgeSwipeBack.ts` therefore tracks the
 *    finger itself (like a leading-edge strip in a native app) and drives the
 *    same previews through {@link touchBack}. When the system does report, it
 *    simply takes over; either way the commit path above does the closing.
 *
 * Layers register a close callback on mount and unregister on unmount; the
 * topmost (most recently opened) layer consumes the back press first.
 *
 * The native side also needs to know *synchronously* whether the web layer has
 * anything to consume (it decides between "I animate it" and "the system plays
 * its back-to-home animation"), so every empty ⇄ non-empty transition of the
 * stack is mirrored to native via `setBackInterceptEnabled`.
 */

type BackCloseFn = () => void;

export type BackEdge = 'left' | 'right';

/** One smoothed frame of the gesture, handed to the active preview. */
export interface BackGestureFrame {
  /** 0 (finger at the edge) → 1 (swiped all the way across). */
  progress: number;
  /** Which screen edge the swipe started from. */
  edge: BackEdge;
  /** Vertical finger travel since the gesture began, in CSS px. */
  dy: number;
  /** Absolute finger Y in CSS px (viewport), for tilting toward the finger. */
  y: number;
}

/**
 * How a layer shows an in-flight back gesture. All methods must be safe to call
 * after the layer's element has been removed from the document.
 */
export interface BackPreview {
  /** Gesture began; take over the element (stop its entrance animation etc.). */
  start(edge: BackEdge): void;
  /** Called at most once per display frame with the smoothed gesture state. */
  update(frame: BackGestureFrame): void;
  /** Finger lifted without committing: settle back to rest. */
  cancel(): void;
  /**
   * Gesture committed; `close()` runs right after. Continue the motion from the
   * current pose (the layer's own exit animation takes over) — and restore the
   * rest pose if the layer turns out not to close (e.g. a confirm dialog).
   */
  commit(): void;
}

interface BackEntry {
  close: BackCloseFn;
  preview?: BackPreview;
}

const stack: BackEntry[] = [];

// ---------------------------------------------------------------------------
// Diagnostics (shown on the mobile debug page)
// ---------------------------------------------------------------------------

/**
 * What the web layer has seen from native, so "swiping does nothing on this
 * phone" can be told apart on the device itself: did native ever receive
 * progress events (starts / frames), or only the final commit?
 */
export interface BackDiagnostics {
  /** Layers currently registered. */
  stackDepth: number;
  /** Last intercept value pushed to native (null = never pushed). */
  interceptSent: boolean | null;
  /** `__marcelBackStart` calls received — native delivers gesture start. */
  starts: number;
  /** `__marcelBackProgress` calls received — native delivers per-frame progress. */
  frames: number;
  cancels: number;
  /** `__marcelHandleBack` calls — the commit path (also the legacy button). */
  commits: number;
  lastProgress: number;
  /** Whether the top layer at the last gesture start had a preview. */
  topHadPreview: boolean | null;
  /** The webview reports prefers-reduced-motion (previews are skipped). */
  reducedMotion: boolean;
  /** In-app edge swipes that started tracking the finger. */
  touchStarts: number;
  /** In-app edge swipes released past the threshold (committed). */
  touchCommits: number;
}

let diag: BackDiagnostics = {
  stackDepth: 0,
  interceptSent: null,
  starts: 0,
  frames: 0,
  cancels: 0,
  commits: 0,
  lastProgress: 0,
  topHadPreview: null,
  reducedMotion: false,
  touchStarts: 0,
  touchCommits: 0,
};
const diagListeners = new Set<() => void>();

function bumpDiag(patch: Partial<BackDiagnostics>): void {
  diag = { ...diag, ...patch };
  diagListeners.forEach((l) => l());
}

/** Snapshot for `useSyncExternalStore` (a new object per change). */
export function getBackDiagnostics(): BackDiagnostics {
  return diag;
}

export function subscribeBackDiagnostics(listener: () => void): () => void {
  diagListeners.add(listener);
  return () => {
    diagListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Native sync: "does the web layer have anything to consume?"
// ---------------------------------------------------------------------------

let nativeEnabled: boolean | null = null;
let syncQueued = false;

/**
 * Talks to `window.AndroidBridge` directly (type declared in mobileBridge.ts)
 * instead of importing it: this module stays dependency-free so tests that
 * mock mobileBridge don't have to know about back handling. Desktop and old
 * APKs have no such method — then this is a no-op.
 */
function setBackInterceptEnabled(enabled: boolean): void {
  try {
    window.AndroidBridge?.setBackIntercept?.(enabled);
  } catch (e) {
    console.warn('[backHandler] setBackIntercept failed:', e);
  }
}

/**
 * Coalesce to the end of the current task: a layer re-registering (cleanup +
 * register in one React commit) would otherwise flicker native 1→0→1 and, if a
 * gesture were in flight, make the system cancel it.
 */
function queueNativeSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    const want = stack.length > 0;
    if (want === nativeEnabled) {
      if (diag.stackDepth !== stack.length) bumpDiag({ stackDepth: stack.length });
      return;
    }
    nativeEnabled = want;
    setBackInterceptEnabled(want);
    bumpDiag({ stackDepth: stack.length, interceptSent: want });
  });
}

// ---------------------------------------------------------------------------
// Gesture session (smoothing + dispatch to the active preview)
// ---------------------------------------------------------------------------

/**
 * Smoothing time constant. Native progress events arrive in irregular bursts
 * (and cross a thread hop); following them raw looks twitchy. A short
 * exponential follow hides the jitter at the cost of ~1 frame of lag.
 */
const SMOOTH_TAU_MS = 38;
const SETTLE_EPSILON = 0.002;

interface GestureSession {
  entry: BackEntry;
  /** Who is reporting the finger: the system (smoothed) or our own touch tracking (1:1). */
  source: 'system' | 'touch';
  edge: BackEdge;
  startY: number;
  target: BackGestureFrame;
  current: BackGestureFrame;
  raf: number | null;
  lastT: number;
  /** touchcancel grace: the system took the finger, wait for its commit. */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/** After touchcancel, how long to wait for the system's own commit before giving up. */
const TOUCH_CANCEL_GRACE_MS = 200;

/** Native reports Y in physical px; the page works in CSS px. */
function cssPx(physical: number): number {
  const dpr = window.devicePixelRatio;
  return dpr > 0 ? physical / dpr : physical;
}

let session: GestureSession | null = null;

function normalizeEdge(edge: number): BackEdge {
  // BackEventCompat.EDGE_LEFT = 0, EDGE_RIGHT = 1
  return edge === 1 ? 'right' : 'left';
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function stopLoop(s: GestureSession): void {
  if (s.raf != null) {
    cancelAnimationFrame(s.raf);
    s.raf = null;
  }
  if (s.graceTimer != null) {
    clearTimeout(s.graceTimer);
    s.graceTimer = null;
  }
}

function tick(now: number): void {
  const s = session;
  if (!s) return;
  s.raf = null;
  // The layer vanished under the finger (closed by other means): drop the
  // session quietly; a later commit still closes whatever is on top.
  if (!stack.includes(s.entry)) {
    session = null;
    s.entry.preview?.cancel();
    return;
  }
  const dt = Math.min(Math.max(now - s.lastT, 1), 64);
  s.lastT = now;
  const k = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
  const cur = s.current;
  const tgt = s.target;
  cur.progress += (tgt.progress - cur.progress) * k;
  cur.dy += (tgt.dy - cur.dy) * k;
  cur.y += (tgt.y - cur.y) * k;
  cur.edge = tgt.edge;
  const settled =
    Math.abs(tgt.progress - cur.progress) < SETTLE_EPSILON &&
    Math.abs(tgt.dy - cur.dy) < 0.5 &&
    Math.abs(tgt.y - cur.y) < 0.5;
  if (settled) {
    cur.progress = tgt.progress;
    cur.dy = tgt.dy;
    cur.y = tgt.y;
  }
  s.entry.preview?.update({ ...cur });
  if (!settled) s.raf = requestAnimationFrame(tick);
}

function ensureLoop(s: GestureSession): void {
  if (s.raf != null) return;
  s.lastT = performance.now();
  s.raf = requestAnimationFrame(tick);
}

function endSession(mode: 'cancel' | 'commit'): void {
  const s = session;
  if (!s) return;
  session = null;
  stopLoop(s);
  if (mode === 'cancel') s.entry.preview?.cancel();
}

function startGesture(edge: number, physicalY: number): void {
  const y = cssPx(physicalY);
  // Our own touch tracking already follows this finger (the system reports
  // the same swipe too, e.g. on a Pixel): adopt it instead of restarting, so
  // the preview doesn't flinch back to rest and out again.
  if (session?.source === 'touch') {
    bumpDiag({ starts: diag.starts + 1 });
    stopLoop(session);
    session.source = 'system';
    session.startY = y - session.target.dy;
    return;
  }
  // A previous gesture the system never resolved: settle it first.
  endSession('cancel');
  const top = stack[stack.length - 1];
  const reduced = prefersReducedMotion();
  bumpDiag({
    starts: diag.starts + 1,
    topHadPreview: top?.preview != null,
    reducedMotion: reduced,
  });
  if (!top?.preview || reduced) return;
  const e = normalizeEdge(edge);
  const frame = (): BackGestureFrame => ({ progress: 0, edge: e, dy: 0, y });
  session = {
    entry: top,
    source: 'system',
    edge: e,
    startY: y,
    target: frame(),
    current: frame(),
    raf: null,
    lastT: 0,
    graceTimer: null,
  };
  top.preview.start(e);
}

function progressGesture(progress: number, edge: number, physicalY: number): void {
  bumpDiag({ frames: diag.frames + 1, lastProgress: progress });
  const s = session;
  if (!s) return;
  const y = cssPx(physicalY);
  s.target = {
    progress: Math.min(Math.max(progress, 0), 1),
    edge: normalizeEdge(edge),
    dy: y - s.startY,
    y,
  };
  ensureLoop(s);
}

/**
 * The in-app edge swipe's way in (see `edgeSwipeBack.ts`). Unlike the system's
 * events these are the finger itself, so frames go to the preview 1:1 with no
 * smoothing: direct manipulation must not lag the finger.
 */
export const touchBack = {
  /** Is there a layer with a preview to drive, and motion allowed? */
  canStart(): boolean {
    return stack[stack.length - 1]?.preview != null && !prefersReducedMotion();
  },
  /** Finger committed to a back swipe from `edge`. False: nothing to preview. */
  begin(edge: BackEdge, y: number): boolean {
    endSession('cancel');
    const top = stack[stack.length - 1];
    if (!top?.preview || prefersReducedMotion()) return false;
    const frame = (): BackGestureFrame => ({ progress: 0, edge, dy: 0, y });
    session = {
      entry: top,
      source: 'touch',
      edge,
      startY: y,
      target: frame(),
      current: frame(),
      raf: null,
      lastT: 0,
      graceTimer: null,
    };
    bumpDiag({ touchStarts: diag.touchStarts + 1 });
    top.preview.start(edge);
    top.preview.update({ ...session.current });
    return true;
  },
  move(progress: number, y: number): void {
    const s = session;
    if (!s || s.source !== 'touch') return;
    if (!stack.includes(s.entry)) return;
    const frame: BackGestureFrame = {
      progress: Math.min(Math.max(progress, 0), 1),
      edge: s.edge,
      dy: y - s.startY,
      y,
    };
    s.target = frame;
    s.current = { ...frame };
    s.entry.preview?.update({ ...frame });
  },
  /** Finger lifted: close the layer (continuing from the pose) or settle back. */
  end(commit: boolean): void {
    const s = session;
    if (!s || s.source !== 'touch') return;
    if (commit) {
      bumpDiag({ touchCommits: diag.touchCommits + 1 });
      popAndClose();
    } else {
      endSession('cancel');
    }
  },
  /**
   * `touchcancel`: usually the system took the finger for its own back gesture
   * and will follow with a commit (or a cancel). Hold the pose for a moment so
   * that commit continues from it; give up if nothing comes.
   */
  drop(): void {
    const s = session;
    if (!s || s.source !== 'touch') return;
    stopLoop(s);
    s.graceTimer = setTimeout(() => {
      s.graceTimer = null;
      if (session === s && s.source === 'touch') endSession('cancel');
    }, TOUCH_CANCEL_GRACE_MS);
  },
};

function popAndClose(): boolean {
  bumpDiag({ commits: diag.commits + 1 });
  const top = stack[stack.length - 1];
  const s = session;
  if (s) {
    if (top && s.entry === top) {
      // Freeze at the last frame the user saw, then let the layer continue.
      stopLoop(s);
      session = null;
      top.preview?.commit();
    } else {
      endSession('cancel');
    }
  }
  if (top == null) return false;
  // Remove before invoking: close() triggers React state updates that will
  // synchronously run the layer's cleanup, which would otherwise try to
  // unregister the same entry twice.
  stack.pop();
  queueNativeSync();
  top.close();
  return true;
}

declare global {
  interface Window {
    __marcelHandleBack?: () => boolean;
    __marcelBackStart?: (edge: number, touchY: number) => void;
    __marcelBackProgress?: (progress: number, edge: number, touchY: number) => void;
    __marcelBackCancel?: () => void;
  }
}

if (typeof window !== 'undefined') {
  window.__marcelHandleBack = popAndClose;
  window.__marcelBackStart = startGesture;
  window.__marcelBackProgress = progressGesture;
  window.__marcelBackCancel = () => {
    bumpDiag({ cancels: diag.cancels + 1 });
    endSession('cancel');
  };
  // A reloaded page starts with an empty stack while native may still believe
  // there is something to consume; say so explicitly.
  queueNativeSync();
}

/**
 * Register a layer that should consume the next Android back press. Returns an
 * unregister function — call it from the owning component's cleanup. Calling
 * unregister for a layer that was already popped is a no-op.
 *
 * `preview` (optional) lets the layer follow a predictive-back gesture; layers
 * without one simply close on commit, exactly as before.
 */
export function registerBackHandler(
  close: BackCloseFn,
  preview?: BackPreview,
): () => void {
  const entry: BackEntry = { close, preview };
  stack.push(entry);
  queueNativeSync();
  return () => {
    const idx = stack.lastIndexOf(entry);
    if (idx >= 0) {
      stack.splice(idx, 1);
      queueNativeSync();
    }
  };
}

/** Test helper / escape hatch. */
export function resetBackHandlers(): void {
  endSession('cancel');
  stack.length = 0;
  queueNativeSync();
}
