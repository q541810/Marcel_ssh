/**
 * The bottom sheet's motion (`MobileSheet`) — a *manager*: it coordinates the
 * sheet, the dimmed backdrop behind it and every way the sheet can come or go
 * (opening, the Close button, tapping the backdrop, pulling down on its
 * handle, the system back gesture) so they all behave as one thing.
 *
 * The rule is "back the way it came": the sheet rose from the bottom, so it
 * sinks straight back down to the bottom — no tilt, no turn, no wobble.
 *
 * - One number, `y` (how far the sheet has sunk, px), describes the whole scene:
 *   the backdrop's brightness is *computed from it* ({@link scrimAt}), so the
 *   two can never drift apart, whatever is moving the sheet.
 * - Everything that moves the sheet after the finger lets go is the same
 *   spring, started from where the sheet is shown *and the speed it has*:
 *   a flick goes out fast, a slow pull goes out gently, a cancelled swipe
 *   returns without a jolt. Any of them can be interrupted by the next touch
 *   at any moment, which picks up from the presented position (no snap).
 * - While the system back gesture is held, the sheet sinks by an amount that
 *   is front-loaded (quick at first, slower, barely moving at the end — same
 *   rule as the pages, `follow` in backFeel.ts).
 * - Only `transform` and `opacity` are written, on the sheet and the backdrop.
 *
 * The layer's own CSS exit class (globals.css `[data-back]` rules) is switched
 * to a timing-only hold for as long as the flight plays, so React keeps the
 * sheet mounted until it has left.
 */

import type { BackGestureFrame, BackPreview } from './backHandler';
import { getBackFeel, type BackFeel } from './backFeel';
import { viewportHeight, viewportWidth } from './backPreview';
import {
  Blend,
  clamp,
  frontLoaded,
  keyframes,
  prefersReducedMotion,
  Recorder,
  sampled,
  softLimit,
  speedAt,
  springPath,
  type Channels,
  type Trajectory,
} from './motion';
import { holdExitFallback } from '@/hooks/useAnimatedPresence';

/** How far a full-width sheet drop reaches while held, share of the sheet's height (capped). */
const HOLD_SHARE = 0.3;
const HOLD_CAP_PX = 240;
/** The backdrop's brightness lost by the time the held sheet has sunk that far. */
const HOLD_DIM = 0.55;
/** Share of the screen width a swipe needs to show the whole held effect. */
const HOLD_SPAN = 0.5;
/** Room past the screen edge so the sheet's own shadow has left too, px. */
const SHADOW_ALLOWANCE_PX = 48;
/** The flight out aims this much further than "just off-screen", so it leaves at speed. */
const OUT_REACH = 1.2;
/** After a commit the sheet gets this long to start its own close; then it turns back. */
const COMMIT_GRACE_MS = 220;
/** Apple's scroll-deceleration constant, used to project where a release would come to rest. */
const DECELERATION = 0.998;

interface Y extends Channels {
  /** How far down from its resting place, px (≥ 0 except a small elastic pull-up). */
  y: number;
}

export interface Geo {
  /** `y` at which the sheet (and its shadow) is completely out of sight. */
  off: number;
  /** `y` reached by a held back swipe at full strength. */
  hold: number;
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

export function geometry(top: number, height: number, screenHeight: number): Geo {
  const off = Math.max(screenHeight - top, height) + SHADOW_ALLOWANCE_PX;
  const hold = Math.min(clamp(height * HOLD_SHARE, 1, HOLD_CAP_PX), off * 0.9);
  return { off, hold };
}

/**
 * Backdrop brightness for a sheet sunk `y` px (1 = fully shown). A single
 * continuous curve from "sheet at rest" to "sheet gone", so every way of moving
 * the sheet dims and clears the backdrop in step with it.
 */
export function scrimAt(y: number, g: Geo): number {
  const v = Math.max(0, y);
  if (v <= g.hold) return 1 - (HOLD_DIM * v) / g.hold;
  return (1 - HOLD_DIM) * (1 - clamp((v - g.hold) / (g.off - g.hold), 0, 1));
}

/** Sink for a held back swipe. */
export function heldY(frame: Pick<BackGestureFrame, 'dx'>, g: Geo, feel: Pick<BackFeel, 'follow'>): number {
  return g.hold * frontLoaded(frame.dx / (viewportWidth() * HOLD_SPAN), feel.follow);
}

/** Pulling the handle: follows the finger 1:1 downward, a short elastic give upward. */
export function draggedY(dy: number): number {
  return dy >= 0 ? dy : -softLimit(-dy, 28);
}

/** Where a release at speed `vPxS` (px/s, downward positive) would come to rest. */
export function projectedY(y: number, vPxS: number): number {
  return y + ((vPxS / 1000) * DECELERATION) / (1 - DECELERATION);
}

/** Should a pull released at `y` moving `vPxS` dismiss the sheet? */
export function shouldDismiss(y: number, vPxS: number, height: number): boolean {
  return projectedY(y, vPxS) > Math.max(height * 0.45, 80);
}

function settleSpring(from: number, v: number, to: number, response: number) {
  return springPath<Y>({ y: from }, { y: v }, { y: to }, {
    response,
    tolerance: () => 0.4,
    maxMs: 1400,
  });
}

/** Back down to rest from where the sheet is, at the speed it has. */
export function flightHome(from: number, v: number, response: number) {
  const { path, ms } = settleSpring(from, v, 0, response);
  return { path, ms };
}

/**
 * Out of sight, the way it came: the spring aims past the edge so the sheet
 * leaves at speed, and the flight ends the moment it is gone (the unmount
 * waits only that long).
 */
export function flightOut(from: number, v: number, g: Geo, response: number) {
  const far = Math.max(g.off * OUT_REACH, from + 80);
  const run = settleSpring(from, v, far, response);
  let n = run.samples.findIndex((s) => s.y >= g.off);
  if (n < 0) n = run.samples.length - 1;
  n = Math.max(n, 2);
  const samples = run.samples.slice(0, n + 1);
  while (samples.length < n + 1) samples.push({ y: far });
  samples[n] = { y: Math.max(samples[n].y, g.off) };
  return { path: sampled(samples, run.dt) as Trajectory<Y>, ms: n * run.dt };
}

/** Rising into place from below the screen. */
export function flightIn(from: number, v: number, response: number) {
  return flightHome(from, v, response);
}

// ---------------------------------------------------------------------------
// The sheet and its backdrop, as one thing
// ---------------------------------------------------------------------------

function translate(y: number): string {
  return `translate3d(0, ${y.toFixed(2)}px, 0)`;
}

class SheetStage {
  el: HTMLElement | null = null;
  private scrim: HTMLElement | null = null;
  geo: Geo = { off: 600, hold: 120 };
  height = 400;
  private last: Y = { y: 0 };
  private anims: Animation[] = [];
  private playing: { path: Trajectory<Y>; ms: number; started: number } | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rec = new Recorder<Y>();
  private readonly blend = new Blend<Y>();

  constructor(
    private readonly resolveSheet: () => HTMLElement | null,
    private readonly resolveScrim: () => HTMLElement | null,
  ) {}

  get isPlaying(): boolean {
    return this.playing != null;
  }

  /** Take over the sheet and its backdrop (no-op if already ours). False if there is no sheet. */
  attach(): boolean {
    const el = this.resolveSheet();
    if (!el) return false;
    const fresh = !(this.el === el && el.isConnected);
    if (fresh) {
      this.cleanup();
      this.el = el;
      this.scrim = this.resolveScrim();
    }
    // Switches the exit classes to the timing-only hold (globals.css).
    el.dataset.back = 'sheet';
    if (this.scrim) this.scrim.dataset.back = 'fade';
    // The CSS entrance fills `forwards` and would pin the element above our inline
    // pose; cancelling a CSS animation sticks until its name changes.
    for (const node of [el, this.scrim]) {
      for (const a of node?.getAnimations?.() ?? []) {
        if (/Enter$/.test((a as CSSAnimation).animationName ?? '')) a.cancel();
      }
    }
    if (!fresh) return true;
    const r = el.getBoundingClientRect();
    this.height = r.height || 1;
    this.geo = geometry(r.top, r.height, viewportHeight());
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    if (this.scrim) this.scrim.style.willChange = 'opacity';
    this.last = { y: 0 };
    this.rec.reset();
    this.blend.clear();
    return true;
  }

  /** Presented position and its speed (per ms) — mid-flight if one is playing. */
  now(): [Y, Y] {
    const p = this.playing;
    if (p) {
      const t = clamp(performance.now() - p.started, 0, p.ms);
      return [p.path(t), speedAt(p.path, t)];
    }
    return [this.last, this.rec.velocity(this.last)];
  }

  /** The finger takes over: stop any flight, blending from where the sheet was shown. */
  hold(first: Y): void {
    const shown = this.playing ? this.now()[0] : null;
    this.stop();
    this.rec.reset();
    this.blend.from(shown, first);
    // Stopping the animation uncovers the inline pose (the flight's end): keep
    // showing where the sheet was until the finger's first frame arrives.
    if (shown) {
      this.last = shown;
      this.write(shown);
    }
  }

  set(y: Y): void {
    const shown = this.blend.apply(y);
    this.last = shown;
    this.rec.push(shown);
    this.write(shown);
  }

  play(path: Trajectory<Y>, ms: number, onDone?: () => void): void {
    const el = this.el;
    if (!el) return;
    this.stop();
    const g = this.geo;
    const end = path(ms);
    // The inline pose is what shows if Web Animations are unavailable.
    this.last = end;
    this.write(end);
    this.playing = { path, ms, started: performance.now() };
    if (typeof el.animate !== 'function') {
      onDone?.();
      return;
    }
    const anim = el.animate(
      keyframes(path, ms, (p) => ({ transform: translate(p.y) })),
      { duration: ms, fill: 'forwards' },
    );
    this.anims = [anim];
    if (this.scrim) {
      this.anims.push(
        this.scrim.animate(
          keyframes(path, ms, (p) => ({ opacity: scrimAt(p.y, g) })),
          { duration: ms, fill: 'forwards' },
        ),
      );
    }
    let done = false;
    const finish = () => {
      if (done || this.anims[0] !== anim) return;
      done = true;
      if (this.doneTimer != null) clearTimeout(this.doneTimer);
      this.doneTimer = null;
      onDone?.();
    };
    anim.onfinish = finish;
    // Backstop: a backgrounded WebView may deliver `finish` late.
    this.doneTimer = setTimeout(finish, ms + 120);
  }

  /** Timing for the layer's exit class, so the unmount waits for the flight. */
  holdUnmount(ms: number): void {
    const v = `${Math.round(ms)}ms`;
    this.el?.style.setProperty('--back-ms', v);
    this.scrim?.style.setProperty('--back-ms', v);
    if (typeof this.el?.animate === 'function') holdExitFallback(ms + 80);
  }

  /** While leaving, taps go to whatever is behind. */
  setInert(on: boolean): void {
    const v = on ? 'none' : '';
    if (this.el) this.el.style.pointerEvents = v;
    if (this.scrim) this.scrim.style.pointerEvents = v;
  }

  cleanup(): void {
    this.stop();
    const el = this.el;
    const scrim = this.scrim;
    this.el = null;
    this.scrim = null;
    this.last = { y: 0 };
    this.blend.clear();
    if (el) {
      delete el.dataset.back;
      const s = el.style;
      s.transition = '';
      s.willChange = '';
      s.transform = '';
      s.pointerEvents = '';
      s.removeProperty('--back-ms');
    }
    if (scrim) {
      delete scrim.dataset.back;
      const s = scrim.style;
      s.willChange = '';
      s.opacity = '';
      s.pointerEvents = '';
      s.removeProperty('--back-ms');
    }
  }

  private write(p: Y): void {
    const el = this.el;
    if (!el) return;
    el.style.transform = translate(p.y);
    if (this.scrim) this.scrim.style.opacity = scrimAt(p.y, this.geo).toFixed(3);
  }

  private stop(): void {
    if (this.doneTimer != null) {
      clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    this.anims.forEach((a) => a.cancel());
    this.anims = [];
    this.playing = null;
  }
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export interface SheetMotion {
  /** Register with `registerBackHandler` for the predictive-back gesture. */
  preview: BackPreview;
  /** The sheet is shown (or shown again): rise into place. */
  enter(): void;
  /** The sheet's `open` went false: sink back down. */
  exit(): void;
  /** Pulling the handle down with a finger. */
  drag: {
    /** The finger is `dy` px below where it touched down. */
    move(dy: number): void;
    /** Finger lifted. Returns whether the sheet is being dismissed (call `onClose`). */
    end(): 'close' | 'stay';
    /** The touch was taken away: return to rest. */
    cancel(): void;
  };
  /** The sheet is gone: drop whatever is left behind. */
  dispose(): void;
}

/** One sheet's motion. `getSheet` / `getBackdrop` are read each time (the elements come and go). */
export function createSheetMotion(
  getSheet: () => HTMLElement | null,
  getBackdrop: () => HTMLElement | null,
): SheetMotion {
  const stage = new SheetStage(getSheet, getBackdrop);
  let feel: BackFeel = getBackFeel();
  /** The sheet is on its way out (gesture commit, drag dismissal or close). */
  let leaving = false;
  /** The sheet's own close has started this open cycle. */
  let closing = false;
  /** A drag on the handle is in progress. */
  let dragging = false;
  let grace: ReturnType<typeof setTimeout> | null = null;

  const clearGrace = () => {
    if (grace != null) clearTimeout(grace);
    grace = null;
  };

  function flyOut(): void {
    const el = stage.el;
    if (!el) return;
    leaving = true;
    stage.setInert(true);
    const [from, v] = stage.now();
    const { path, ms } = flightOut(from.y, v.y, stage.geo, feel.flight);
    stage.holdUnmount(ms);
    stage.play(path, ms, () => {
      // Gone from sight. The sheet unmounts now; until it does, leave it there.
      if (!el.isConnected) stage.cleanup();
    });
  }

  function settleBack(): void {
    leaving = false;
    dragging = false;
    stage.setInert(false);
    const [from, v] = stage.now();
    const { path, ms } = flightHome(from.y, v.y, feel.flight);
    stage.play(path, ms, () => stage.cleanup());
  }

  /** After a dismissal that the sheet's owner never acted on (a declined close), turn back. */
  function armGrace(): void {
    clearGrace();
    grace = setTimeout(() => {
      grace = null;
      const el = stage.el;
      if (!el || !el.isConnected) return stage.cleanup();
      if (closing) return;
      settleBack();
    }, COMMIT_GRACE_MS);
  }

  const preview: BackPreview = {
    start() {
      clearGrace();
      feel = getBackFeel();
      if (!stage.attach()) return;
      leaving = false;
      stage.setInert(false);
      stage.hold({ y: 0 });
    },
    update(frame) {
      if (!stage.el) return;
      stage.set({ y: heldY(frame, stage.geo, feel) });
    },
    cancel() {
      if (!stage.el) return;
      settleBack();
    },
    commit() {
      if (!stage.el) return;
      flyOut();
      armGrace();
    },
  };

  return {
    preview,
    enter() {
      closing = false;
      clearGrace();
      if (prefersReducedMotion()) return;
      const el0 = getSheet();
      // Reopened mid-flight: same element, turn around from where it is shown.
      const wasOurs = el0 != null && stage.el === el0 && stage.isPlaying;
      feel = getBackFeel();
      if (!stage.attach()) return;
      leaving = false;
      dragging = false;
      stage.setInert(false);
      const [from, v] = wasOurs ? stage.now() : [{ y: stage.geo.off }, { y: 0 }];
      const { path, ms } = flightIn(from.y, v.y, feel.flight);
      stage.play(path, ms, () => stage.cleanup());
    },
    exit() {
      if (closing) return;
      closing = true;
      clearGrace();
      if (leaving || prefersReducedMotion()) return;
      feel = getBackFeel();
      if (!stage.attach()) return;
      dragging = false;
      flyOut();
    },
    drag: {
      move(dy) {
        if (leaving) return;
        if (!dragging) {
          // A tap on the handle is not a drag: wait for real movement.
          if (Math.abs(dy) < 3) return;
          clearGrace();
          feel = getBackFeel();
          if (!stage.attach()) return;
          dragging = true;
          stage.hold({ y: draggedY(dy) });
        }
        stage.set({ y: draggedY(dy) });
      },
      end() {
        if (!dragging) return 'stay';
        dragging = false;
        const [at, v] = stage.now();
        if (shouldDismiss(at.y, v.y * 1000, stage.height)) {
          flyOut();
          armGrace();
          return 'close';
        }
        settleBack();
        return 'stay';
      },
      cancel() {
        if (!dragging) return;
        dragging = false;
        settleBack();
      },
    },
    dispose() {
      clearGrace();
      leaving = false;
      closing = false;
      dragging = false;
      stage.cleanup();
    },
  };
}
