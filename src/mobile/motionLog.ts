/**
 * What page opens and back gestures actually cost on this phone — recorded
 * app-wide and kept, so the user can open real pages, come back to the debug
 * page and read the numbers ("卡" stops being a guess).
 *
 * A pure function module: one global tap listener plus a small ring buffer.
 * `pageMotion` reports each open, `backHandler` each gesture; nothing here
 * changes how anything moves.
 *
 * An open is split where the wait can come from:
 * - lift → click: the finger lifted until the WebView delivered the tap (a
 *   WebView that holds taps back, or a busy main thread, shows here).
 * - click → built: the tap until the page existed (the tap handler and React
 *   mounting the page — main-thread work).
 * - built → moving: the page existed until its first frame was on screen
 *   (the rest of that task, layout, paint, raster — the animation's own start
 *   time, set by the compositor, marks it).
 * - content: a shell-first page builds its content after the card started to
 *   grow — how long that took, and whether it came late enough to fade in.
 * - frames while it grew: how often the main thread missed a frame meanwhile
 *   (the growing itself runs on the compositor; a busy main thread shows here).
 */

export interface OpenRecord {
  kind: 'open';
  /** Wall clock, ms. */
  at: number;
  page: string;
  /** Finger lift → click delivered, ms. Null when no tap opened it. */
  liftToClick: number | null;
  /** Click → page built, ms. Null when no tap opened it. */
  tapToBuilt: number | null;
  /** Page built → first frame of its motion on screen, ms. Null if unknown. */
  builtToMoving: number | null;
  /**
   * Page built → its content built, ms, for a shell that shows the empty card
   * first (null: the content came with the shell).
   */
  contentMs: number | null;
  /** The content came late and was faded in. */
  contentFaded: boolean;
  frames: number;
  late: number;
  worstMs: number;
}

export interface GestureRecord {
  kind: 'gesture';
  at: number;
  outcome: 'back' | 'cancel';
  frames: number;
  late: number;
  worstMs: number;
}

export type MotionRecord = OpenRecord | GestureRecord;

const KEEP = 12;
/** A tap older than this did not open the page. */
const TAP_WINDOW_MS = 1500;
/** A gap longer than this between frames means at least one was skipped. */
const LATE_FRAME_MS = 25;

let records: MotionRecord[] = [];
const listeners = new Set<() => void>();

function push(r: MotionRecord): void {
  // Newest first by when it began (an open is filed only once it has settled).
  records = [r, ...records].sort((a, b) => b.at - a.at).slice(0, KEEP);
  listeners.forEach((l) => l());
}

/** Newest first. A new array per change (for `useSyncExternalStore`). */
export function getMotionLog(): MotionRecord[] {
  return records;
}

export function subscribeMotionLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearMotionLog(): void {
  records = [];
  listeners.forEach((l) => l());
}

let lastTap = -Infinity;
let lastLift = -Infinity;
let tapLift: number | null = null;

if (typeof window !== 'undefined') {
  // Event timeStamps are on the performance.now() clock: when it happened, not
  // when the busy main thread got round to it.
  // (Some WebViews, and jsdom, stamp events on the wall clock instead: fall
  // back to "now" when the stamp is not on the page clock.)
  const at = (e: Event) => {
    const n = performance.now();
    const t = e.timeStamp;
    return t > 0 && t <= n && n - t < 10_000 ? t : n;
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('pointerup', (e) => (lastLift = at(e)), opts);
  window.addEventListener(
    'click',
    (e) => {
      lastTap = at(e);
      const gap = lastTap - lastLift;
      tapLift = gap >= 0 && gap <= TAP_WINDOW_MS ? Math.round(gap) : null;
    },
    opts,
  );
}

function pageName(el: Element): string {
  const heading = el.querySelector('h1, h2')?.textContent?.trim();
  const name = heading || el.getAttribute('data-region') || el.getAttribute('aria-label') || '页面';
  return name.length > 16 ? `${name.slice(0, 16)}…` : name;
}

/** Frame pacing on the main thread from now for `ms`. */
function pace(ms: number, done: (frames: number, late: number, worstMs: number) => void): void {
  if (typeof requestAnimationFrame !== 'function') return done(0, 0, 0);
  let frames = 0;
  let late = 0;
  let worst = 0;
  let prev = -1;
  const end = performance.now() + ms;
  const tick = (t: number) => {
    if (prev >= 0) {
      const gap = t - prev;
      frames += 1;
      if (gap > LATE_FRAME_MS) late += 1;
      worst = Math.max(worst, gap);
    }
    prev = t;
    if (t < end) requestAnimationFrame(tick);
    else done(frames, late, Math.round(worst));
  };
  requestAnimationFrame(tick);
}

/** How long a record waits for a shell's content to arrive before it is filed without it. */
const CONTENT_WAIT_MS = 3000;

/** Open records still waiting for their content (see `noteContent`). */
const awaitingContent = new WeakMap<Element, (late: boolean) => void>();

/**
 * A page started opening now (its element exists). Call `moving(anim)` once
 * its open motion is playing; without one, the record has no start time.
 */
export function noteOpen(el: Element): { moving: (anim: Animation | undefined) => void } {
  const at = Date.now();
  const built = performance.now();
  const sinceTap = built - lastTap;
  const tapped = sinceTap >= 0 && sinceTap <= TAP_WINDOW_MS;
  const tapToBuilt = tapped ? Math.round(sinceTap) : null;
  const liftToClick = tapped ? tapLift : null;
  let contentMs: number | null = null;
  let contentFaded = false;
  let contentIn = false;
  let paced: [number, number, number] | null = null;
  let started = false;
  let filed = false;
  let builtToMoving: number | null = null;
  let giveUp: ReturnType<typeof setTimeout> | null = null;

  const file = () => {
    if (filed) return;
    filed = true;
    if (giveUp != null) clearTimeout(giveUp);
    awaitingContent.delete(el);
    const [frames, late, worstMs] = paced ?? [0, 0, 0];
    push({
      kind: 'open',
      at,
      // Read now: a shell-first page has its heading only once the content is in.
      page: pageName(el),
      liftToClick,
      tapToBuilt,
      builtToMoving,
      contentMs,
      contentFaded,
      frames,
      late,
      worstMs,
    });
  };
  const maybeFile = () => {
    if (!paced || !started) return;
    if (contentIn) return file();
    giveUp ??= setTimeout(file, CONTENT_WAIT_MS);
  };
  awaitingContent.set(el, (late) => {
    contentMs = Math.round(performance.now() - built);
    contentFaded = late;
    contentIn = true;
    maybeFile();
  });

  return {
    moving(anim) {
      const length = Number(anim?.effect?.getComputedTiming().duration);
      const ms = Number.isFinite(length) && length > 0 ? length : 500;
      pace(ms, (...p) => {
        paced = p;
        maybeFile();
      });
      const settle = () => {
        started = true;
        maybeFile();
      };
      if (!anim) return settle();
      anim.ready
        .then(() => {
          const s = anim.startTime;
          if (typeof s === 'number') builtToMoving = Math.max(0, Math.round(s - built));
        })
        .catch(() => {})
        .finally(settle);
    },
  };
}

/**
 * A shell-first page's content has just been built (`useShellFirst`); `faded`
 * says it came late enough to be faded in.
 */
export function noteContent(el: Element, faded: boolean): void {
  awaitingContent.get(el)?.(faded);
}

export function noteGesture(outcome: GestureRecord['outcome'], frames: number, late: number, worstMs: number): void {
  push({ kind: 'gesture', at: Date.now(), outcome, frames, late, worstMs });
}

/** Test helper. */
export function __resetMotionLog(): void {
  records = [];
  lastTap = -Infinity;
  lastLift = -Infinity;
  tapLift = null;
}
