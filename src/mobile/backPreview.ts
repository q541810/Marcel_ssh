/**
 * Predictive-back previews for the mobile shell's shared layer kinds, and the
 * held-card pose they share.
 *
 * `backHandler.ts` decides *when* a gesture is in flight and hands each frame
 * to the topmost layer's {@link BackPreview}; the previews decide *what that
 * looks like*:
 *
 * - **page** (`MobileFullscreenPage`, `MobileStackPage`) lives in
 *   `pageMotion.ts`: the page lifts off into a card held by the finger
 *   ({@link cardPose}, defined here) and, on release, flies back into the
 *   control it was opened from.
 * - **sheet** (`MobileSheet`) lives in `sheetMotion.ts`: it simply sinks back
 *   the way it came, and its backdrop clears with it.
 * - **peek** (in-page navigation such as "up one folder", the tab fallback):
 *   the held card, gentler; on commit the old content is thrown off and the
 *   previous content turns in from the other side.
 *
 * Every motion is continuous. Release and cancel start from the exact pose on
 * screen *and its current speed*, so nothing stalls, snaps or loses an angle
 * when the finger lets go. They run as Web Animations sampled from a
 * trajectory (motion.ts), so they play on the compositor even while React is
 * busy closing the layer. The layer's own CSS exit class
 * (`[data-back].mobile-*-exit` in globals.css) only times its unmount.
 *
 * Feel parameters live in `backFeel.ts` (tunable from the mobile debug page).
 *
 * ## Cost: compositor properties only
 * Every per-frame write is a `transform` or an `opacity` on a handful of
 * elements. The pose is written straight into `style.transform` rather than
 * into custom properties: a custom property is inherited, so changing one on a
 * layer root would restyle its whole subtree each frame.
 */

import type { BackEdge, BackGestureFrame, BackPreview } from './backHandler';
import { getBackFeel, type BackFeel } from './backFeel';
import {
  clamp,
  absorbable,
  ease,
  frontLoaded,
  hermite as hermiteOf,
  keyframes,
  Recorder,
  smoothstep,
  softLimit,
  speedAt,
  springPath,
  type Channels,
  type Trajectory as TrajectoryOf,
} from './motion';

/** Depth of the 3D effect: larger = flatter. */
export const PERSPECTIVE_PX = 800;
/**
 * Gap the held card keeps from the screen edge, px — some slack for the corner
 * the pitch swings toward the viewer, which the travel limit doesn't model.
 */
const EDGE_MARGIN_PX = 12;
/**
 * After a commit the layer gets this long to start its own exit. If it has not
 * (a "discard changes?" confirm, a handler that declined), the throw is
 * reversed and the layer settles back.
 */
const COMMIT_GRACE_MS = 220;
/** Peek commit: the old content's throw (short — the new content follows). */
const PEEK_THROW_MS = 150;
/** Response of the settle spring, s (≈ 380ms to rest when critically damped). */
const SPRING_RESPONSE = 0.37;

type SurfaceKind = 'peek';

export interface Pose extends Channels {
  /** translate, px */
  x: number;
  y: number;
  /** scale */
  s: number;
  /** tilt around the horizontal / vertical axis, deg */
  rx: number;
  ry: number;
  /** opacity */
  o: number;
}

const REST: Pose = { x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1 };
const STILL: Pose = { x: 0, y: 0, s: 0, rx: 0, ry: 0, o: 0 };

/** A pose over time, `t` in ms from the start of the motion. */
type Trajectory = TrajectoryOf<Pose>;

// ---------------------------------------------------------------------------
// Small math (generic helpers live in motion.ts)
// ---------------------------------------------------------------------------

/** +1 when the swipe moves rightward (from the left edge), -1 leftward. */
export function direction(edge: BackEdge): number {
  return edge === 'left' ? 1 : -1;
}

export function viewportWidth(): number {
  return window.innerWidth || 1;
}

export function viewportHeight(): number {
  return window.innerHeight || 1;
}

/** Finger travel as a share of `span` viewport widths, eased (0 … 1). */
export function travel(frame: BackGestureFrame, span: number): number {
  return ease(frame.dx / (viewportWidth() * span));
}

/**
 * How far perspective pulls the receding edge of a card of half-width `half`
 * turned by `deg` back toward its centre — room the card may use to travel.
 */
export function tiltInset(half: number, deg: number): number {
  const a = (Math.abs(deg) * Math.PI) / 180;
  const z = half * Math.sin(a);
  return half - (half * Math.cos(a) * PERSPECTIVE_PX) / (PERSPECTIVE_PX + z);
}

/**
 * The transform list: perspective, translate3d, rotateX, rotateY, scale (one
 * order everywhere, so nothing ever interpolates between two different lists).
 */
function poseTransform(p: Pose): string {
  return (
    `perspective(${PERSPECTIVE_PX}px) translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) ` +
    `rotateX(${p.rx.toFixed(2)}deg) rotateY(${p.ry.toFixed(2)}deg) scale(${p.s.toFixed(4)})`
  );
}

// ---------------------------------------------------------------------------
// Trajectories
// ---------------------------------------------------------------------------

/** Minimum allowance for a push when start and end almost coincide. */
const TANGENT_FLOOR: Pose = { x: 24, y: 24, s: 0.03, rx: 4, ry: 4, o: 0 };

/** Throw from `from` (moving at `v` per ms) to `to`, arriving at rest after `ms`. */
function hermite(from: Pose, v: Pose, to: Pose, ms: number): Trajectory {
  return hermiteOf(from, v, to, ms, TANGENT_FLOOR);
}

/** Fade opacity out over the last part of a trajectory (from `start` of its length). */
function fadingOut(path: Trajectory, ms: number, start: number): Trajectory {
  return (t) => {
    const p = path(t);
    const u = clamp((t / ms - start) / (1 - start), 0, 1);
    return { ...p, o: p.o * (1 - smoothstep(u)) };
  };
}

/** Settle spring (≈ 380ms to rest): angles may overshoot a touch, positions never. */
function spring(from: Pose, v: Pose, to: Pose): { path: Trajectory; ms: number } {
  return springPath(from, v, to, {
    response: SPRING_RESPONSE,
    damping: { rx: 0.6, ry: 0.6 },
    tolerance: (k) => (k === 'x' || k === 'y' ? 0.3 : k === 'rx' || k === 'ry' ? 0.05 : 0.001),
    maxMs: 1200,
  });
}

function isExiting(el: HTMLElement): boolean {
  const anims = el.getAnimations?.();
  if (anims) {
    return anims.some((a) => /Exit$/.test((a as CSSAnimation).animationName ?? ''));
  }
  return /exit/.test(el.className);
}

// ---------------------------------------------------------------------------
// Surface: one element's pose for the duration of a gesture
// ---------------------------------------------------------------------------

/**
 * Owns one element's pose for the duration of a gesture and restores it
 * afterwards. Never touches `className` (React owns it) — only `data-back`,
 * inline style and Web Animations it starts itself.
 */
class Surface {
  private el: HTMLElement | null = null;
  private anim: Animation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Backstop for `onfinish`, which a backgrounded WebView may deliver late. */
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private last: Pose = REST;
  private readonly rec = new Recorder<Pose>();

  constructor(
    private readonly resolve: () => HTMLElement | null,
    private readonly kind: SurfaceKind,
    private readonly origin?: string,
  ) {}

  get element(): HTMLElement | null {
    return this.el;
  }

  get pose(): Pose {
    return this.last;
  }

  begin(): void {
    // A previous gesture's settle may still be running: finish it now.
    this.cleanup();
    const el = this.resolve();
    if (!el) return;
    // The entrance animation fills `forwards`, and an animation outranks inline
    // style — left alone it would pin the element and swallow our pose. Cancelling
    // a CSS animation is permanent until its `animation-name` changes, so the
    // enter class cannot replay when we clean up.
    for (const a of el.getAnimations?.() ?? []) {
      if (/Enter$/.test((a as CSSAnimation).animationName ?? '')) a.cancel();
    }
    this.el = el;
    this.last = REST;
    this.rec.reset();
    el.dataset.back = this.kind;
    el.style.transition = 'none';
    el.style.willChange = 'transform, opacity';
    if (this.origin) el.style.transformOrigin = this.origin;
  }

  set(pose: Pose): void {
    const el = this.el;
    if (!el) return;
    this.last = pose;
    this.rec.push(pose);
    el.style.transform = poseTransform(pose);
    el.style.opacity = pose.o.toFixed(3);
  }

  /** Speed on screen right now (per ms). */
  velocity(): Pose {
    return this.rec.velocity(REST);
  }

  /** Cancelled gesture: spring back to rest from the current pose and speed. */
  release(from: Pose = this.last, v: Pose = this.velocity()): void {
    const { path, ms } = spring(from, absorbable(from, v, REST, SPRING_RESPONSE), REST);
    this.play(path, ms, () => this.cleanup());
  }

  /**
   * Committed gesture: throw the element along `path`. The layer's own exit
   * class is about to start (it only times the unmount); if it hasn't by
   * {@link COMMIT_GRACE_MS} the layer isn't closing after all — reverse from
   * wherever the throw has got to and settle back (and tell the caller).
   */
  throwOff(path: Trajectory, ms: number, onRevert?: () => void): void {
    const el = this.el;
    if (!el) return;
    // Hold class duration (globals.css) — set once, so the unmount waits for the throw.
    el.style.setProperty('--back-ms', `${Math.round(ms)}ms`);
    const started = performance.now();
    this.play(path, ms, () => {
      if (!el.isConnected) this.cleanup();
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!el.isConnected) return this.cleanup();
      if (isExiting(el)) return;
      const t = Math.min(performance.now() - started, ms);
      this.release(path(t), speedAt(path, t));
      onRevert?.();
    }, COMMIT_GRACE_MS);
  }

  /** Play a trajectory as a Web Animation, starting this very frame. */
  play(path: Trajectory, ms: number, onDone?: () => void): void {
    const el = this.el;
    if (!el) return;
    this.stop();
    const end = path(ms);
    // The inline pose is what shows if Web Animations are unavailable; keep it
    // at the destination so the element still ends up in the right place.
    this.last = end;
    el.style.transform = poseTransform(end);
    el.style.opacity = end.o.toFixed(3);
    if (typeof el.animate !== 'function') {
      onDone?.();
      return;
    }
    const anim = el.animate(
      keyframes(path, ms, (p) => ({ transform: poseTransform(p), opacity: p.o })),
      { duration: ms, fill: 'forwards' },
    );
    this.anim = anim;
    let done = false;
    const finish = () => {
      if (done || this.anim !== anim) return;
      done = true;
      if (this.doneTimer != null) clearTimeout(this.doneTimer);
      this.doneTimer = null;
      onDone?.();
    };
    anim.onfinish = finish;
    this.doneTimer = setTimeout(finish, ms + 120);
  }

  private stop(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.doneTimer != null) {
      clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    this.anim?.cancel();
    this.anim = null;
  }

  private cleanup(): void {
    this.stop();
    const el = this.el;
    this.el = null;
    this.last = REST;
    if (!el) return;
    delete el.dataset.back;
    const s = el.style;
    s.transition = '';
    s.willChange = '';
    s.transformOrigin = '';
    s.transform = '';
    s.opacity = '';
    s.removeProperty('--back-ms');
  }
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

/**
 * A card held by the finger. `amp` scales every effect (1 for pages, gentler
 * for in-page navigation).
 *
 * - Shrink grows with travel.
 * - Turn: toward the swipe direction from the first pixel, full by ~55% of the
 *   width; the side the finger heads for sinks, the edge it came from rises.
 * - Horizontal drift: small (the reference moves the card by a few percent of
 *   the width), only ever toward the swipe direction, and damped against the
 *   room the shrink frees up so the card stays on screen.
 * - Vertical: pitch is the lead — the half of the screen the finger is in
 *   presses in; vertical travel follows the finger a little, damped.
 */
export function cardPose(frame: BackGestureFrame, feel: BackFeel, amp: number): Pose {
  const w = viewportWidth();
  const h = viewportHeight();
  const dir = direction(frame.edge);
  const t = clamp(frame.dx / w, 0, 1);
  // Pitch and lift come in quickly, so a short swipe already feels held.
  const grip = ease(frame.dx / (w * 0.35));
  // Shrink and drift do not track the finger evenly (the user's call, 2026-11-08):
  // quick at the start, easing through the middle, hardly any change at the
  // end — a modest swipe already shows nearly the whole effect, instead of
  // needing a long, fast one to get there.
  const reach = frontLoaded(t, feel.follow);
  const s = 1 - feel.shrink * amp * reach;
  const ry = dir * feel.turn * amp * ease(t / 0.55);
  const roomX = Math.max(0, (w * (1 - s)) / 2 + tiltInset((w * s) / 2, ry) - EDGE_MARGIN_PX);
  const x = dir * softLimit(w * feel.shift * amp * reach, roomX);
  // Finger height, -1 (top) … 1 (bottom); full strength well before the edge.
  const fy = clamp((frame.y - h / 2) / (h * 0.32), -1, 1);
  const rx = -fy * feel.pitch * amp * grip;
  const roomY = Math.min(feel.lift * amp, Math.max(0, (h * (1 - s)) / 2 - EDGE_MARGIN_PX));
  const y = softLimit(frame.dy * 0.35, roomY) * grip;
  return { x, y, s, rx, ry, o: 1 };
}

/**
 * Peek commit: where the old content is thrown — further along, turned toward
 * edge-on, smaller. Opacity is left alone here — the fade is laid over the
 * throw separately ({@link fadingOut}).
 */
function throwTarget(p: Pose, dir: number, feel: BackFeel, amp: number): Pose {
  return {
    x: p.x + dir * viewportWidth() * feel.shift * amp,
    y: p.y + viewportHeight() * 0.03 * amp,
    s: Math.min(p.s, 0.55 + 0.45 * (1 - amp)),
    rx: p.rx * 1.25,
    ry: dir * 60 * amp,
    o: p.o,
  };
}

/** Strength of the in-page card relative to a page. */
const PEEK_AMP = 0.6;

/**
 * In-page navigation (no overlay to peel away): the content area becomes a
 * gentler card. The target is any element marked `data-back-peek` — currently
 * the shell's `<main>` — so every layer of this kind shares one pose. On
 * commit the old content is thrown off and the previous content (swapped in by
 * the layer's close, at a moment we cannot observe) turns in from the other side.
 */
export function peekBackPreview(): BackPreview {
  const surface = new Surface(
    () => document.querySelector<HTMLElement>('[data-back-peek]'),
    'peek',
  );
  let feel = getBackFeel();
  let dir = 1;
  return {
    start(edge) {
      feel = getBackFeel();
      dir = direction(edge);
      surface.begin();
    },
    update(frame) {
      dir = direction(frame.edge);
      surface.set({ ...cardPose(frame, feel, PEEK_AMP), o: 1 - travel(frame, 0.6) * 0.3 });
    },
    cancel: () => surface.release(),
    commit() {
      const from = surface.pose;
      const out = fadingOut(
        hermite(from, surface.velocity(), throwTarget(from, dir, feel, PEEK_AMP), PEEK_THROW_MS),
        PEEK_THROW_MS,
        0,
      );
      surface.play(out, PEEK_THROW_MS, () => {
        const enter: Pose = {
          x: -dir * viewportWidth() * 0.22,
          y: 0,
          s: 1 - feel.shrink * PEEK_AMP * 0.5,
          rx: 0,
          ry: -dir * feel.turn * PEEK_AMP,
          o: 0,
        };
        surface.release(enter, STILL);
      });
    },
  };
}

/** Pure pieces, exported for unit tests only. */
export const __backPreviewMath = { cardPose, throwTarget, hermite, fadingOut, spring, softLimit };
