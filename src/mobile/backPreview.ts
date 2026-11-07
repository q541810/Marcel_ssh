/**
 * Predictive-back previews for the mobile shell's shared layer kinds.
 *
 * `backHandler.ts` decides *when* a gesture is in flight and hands each frame
 * to the topmost layer's {@link BackPreview}; this file decides *what that
 * looks like*. Three poses cover every layer in the app:
 *
 * - **page** (`MobileFullscreenPage`, `MobileStackPage`): the page lifts off
 *   into a rounded card held by the finger. It shrinks with travel and turns
 *   toward the swipe direction from the very first pixel (the side the finger
 *   heads for sinks away, the edge it came from rises) — it never leans back
 *   toward that edge. Vertically the *pitch* does the work: the half of the
 *   screen the finger is in presses in; vertical travel only supports it. The
 *   screen underneath comes forward out of a dimming scrim. On commit the card
 *   is thrown off: it keeps turning, travelling and shrinking, and fades out.
 * - **sheet** (`MobileSheet`): sinks, tips back and turns toward the swipe;
 *   thrown down on commit while its backdrop clears.
 * - **peek** (in-page navigation such as "up one folder", the tab fallback):
 *   the same card, gentler; on commit the old content is thrown off and the
 *   previous content turns in from the other side.
 *
 * Every motion is continuous. Release and cancel start from the exact pose on
 * screen *and its current speed* (measured over the last few frames), so
 * nothing stalls, snaps or loses an angle when the finger lets go. They run as
 * Web Animations — sampled from a per-property trajectory (`hermite` for the
 * throw, a spring for the settle) into keyframes — so they play on the
 * compositor even while React is busy closing the layer. The layer's own CSS
 * exit class (`[data-back].mobile-*-exit` in globals.css) only times its
 * unmount; it doesn't move anything.
 *
 * Feel parameters live in `backFeel.ts` (tunable from the mobile debug page).
 *
 * ## Cost: compositor properties only
 * Every per-frame write is a `transform` or an `opacity` on a handful of
 * elements — both are animated on the GPU without layout or paint. Anything
 * that would repaint a screen-sized layer each frame is deliberately kept
 * constant for the whole gesture instead: the page's corner radius and its
 * shadow are fixed from the first frame (the display's own rounded corners hide
 * the radius at rest), and the dimming is a separate scrim whose opacity moves,
 * not a CSS `filter`. The pose is written straight into `style.transform`
 * rather than into custom properties: a custom property is inherited, so
 * changing one on a page root would restyle the page's whole subtree each frame.
 */

import type { BackEdge, BackGestureFrame, BackPreview } from './backHandler';
import { getBackFeel, type BackFeel } from './backFeel';

/** Depth of the 3D effect: larger = flatter. */
const PERSPECTIVE_PX = 800;
/** Shape of the shrink over the swipe (exponent on the travelled share of the width). */
const SHRINK_CURVE = 2.5;
/** Shape of the horizontal drift over the swipe. */
const DRIFT_CURVE = 3;
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
/**
 * Upper bound for any throw: the layer unmount fallback in useAnimatedPresence
 * fires at 400ms, and the throw must be over by then.
 */
const MAX_THROW_MS = 380;
/** Peek commit: the old content's throw (short — the new content follows). */
const PEEK_THROW_MS = 150;
/** Window over which the on-screen speed is measured at release. */
const VELOCITY_WINDOW_MS = 80;
/** Natural frequency of the settle spring, rad/ms (≈ 380ms to rest when critically damped). */
const SPRING_OMEGA = 0.017;
/** Damping of the settle spring: angles may overshoot a touch, positions never. */
const SPRING_ZETA: Pose = { x: 1, y: 1, s: 1, rx: 0.6, ry: 0.6, o: 1 };

type SurfaceKind = 'page' | 'sheet' | 'fade' | 'peek';

interface Pose {
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

const CHANNELS = ['x', 'y', 's', 'rx', 'ry', 'o'] as const;
const REST: Pose = { x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1 };
const STILL: Pose = { x: 0, y: 0, s: 0, rx: 0, ry: 0, o: 0 };

/** A pose over time, `t` in ms from the start of the motion. */
type Trajectory = (t: number) => Pose;

// ---------------------------------------------------------------------------
// Small math
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Decelerating response 0 … 1: the first part of the swipe already reads clearly. */
function ease(t: number): number {
  const c = clamp(t, 0, 1);
  return 1 - (1 - c) * (1 - c);
}

/**
 * Damping: ≈ `v` while small, then ever harder to pull, approaching ±`limit`
 * but never reaching it. Lets motion stay generous without leaving the screen.
 */
function softLimit(v: number, limit: number): number {
  return limit > 0 ? limit * Math.tanh(v / limit) : 0;
}

/** +1 when the swipe moves rightward (from the left edge), -1 leftward. */
function direction(edge: BackEdge): number {
  return edge === 'left' ? 1 : -1;
}

function viewportWidth(): number {
  return window.innerWidth || 1;
}

function viewportHeight(): number {
  return window.innerHeight || 1;
}

/** Finger travel as a share of `span` viewport widths, eased (0 … 1). */
function travel(frame: BackGestureFrame, span: number): number {
  return ease(frame.dx / (viewportWidth() * span));
}

/**
 * How far perspective pulls the receding edge of a card of half-width `half`
 * turned by `deg` back toward its centre — room the card may use to travel.
 */
function tiltInset(half: number, deg: number): number {
  const a = (Math.abs(deg) * Math.PI) / 180;
  const z = half * Math.sin(a);
  return half - (half * Math.cos(a) * PERSPECTIVE_PX) / (PERSPECTIVE_PX + z);
}

function mapPose(f: (k: (typeof CHANNELS)[number]) => number): Pose {
  return { x: f('x'), y: f('y'), s: f('s'), rx: f('rx'), ry: f('ry'), o: f('o') };
}

/**
 * The transform list. Nothing else (no CSS keyframes) interpolates it any more,
 * but keep one order everywhere: perspective, translate3d, rotateX, rotateY, scale.
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

/** Largest initial push (as a multiple of the distance) a throw accepts. */
const MAX_TANGENT = 2.5;
/** Minimum allowance for a push when start and end almost coincide. */
const TANGENT_FLOOR: Pose = { x: 24, y: 24, s: 0.03, rx: 4, ry: 4, o: 0 };

/**
 * Throw from `from` (moving at `v` per ms) to `to`, arriving at rest after `ms`:
 * a cubic Hermite curve per property, so the start speed matches what was on
 * screen exactly and the end eases out. Pushes are capped so a jittery reading
 * can't fling the card past its target.
 */
function hermite(from: Pose, v: Pose, to: Pose, ms: number): Trajectory {
  const m = mapPose((k) => {
    const cap = MAX_TANGENT * Math.abs(to[k] - from[k]) + TANGENT_FLOOR[k];
    return clamp(v[k] * ms, -cap, cap);
  });
  return (t) => {
    const u = clamp(t / ms, 0, 1);
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    return mapPose((k) => h00 * from[k] + h10 * m[k] + h01 * to[k]);
  };
}

/** Fade opacity out over the last part of a trajectory (from `start` of its length). */
function fadingOut(path: Trajectory, ms: number, start: number): Trajectory {
  return (t) => {
    const p = path(t);
    const u = clamp((t / ms - start) / (1 - start), 0, 1);
    return { ...p, o: p.o * (1 - u * u * (3 - 2 * u)) };
  };
}

/**
 * Damped spring from `from` (moving at `v` per ms) to `to`, simulated per
 * property. Returns the trajectory and how long it takes to settle.
 */
function spring(from: Pose, v: Pose, to: Pose): { path: Trajectory; ms: number } {
  const dt = 4;
  const samples: Pose[] = [];
  const pos = { ...from };
  const vel = { ...v };
  const w = SPRING_OMEGA;
  for (let i = 0; i < 300; i++) {
    samples.push({ ...pos });
    let settled = true;
    for (const k of CHANNELS) {
      const a = -w * w * (pos[k] - to[k]) - 2 * SPRING_ZETA[k] * w * vel[k];
      vel[k] += a * dt;
      pos[k] += vel[k] * dt;
      const tolerance = k === 'x' || k === 'y' ? 0.3 : k === 'rx' || k === 'ry' ? 0.05 : 0.001;
      if (Math.abs(pos[k] - to[k]) > tolerance || Math.abs(vel[k]) * 16 > tolerance) settled = false;
    }
    if (settled && i > 2) break;
  }
  samples.push({ ...to });
  const ms = (samples.length - 1) * dt;
  return {
    ms,
    path: (t) => {
      const f = clamp(t / dt, 0, samples.length - 1);
      const i = Math.floor(f);
      const j = Math.min(i + 1, samples.length - 1);
      const r = f - i;
      return mapPose((k) => samples[i][k] + (samples[j][k] - samples[i][k]) * r);
    },
  };
}

/** Speed of a trajectory at `t` (per ms), by central difference. */
function speedAt(path: Trajectory, t: number): Pose {
  const a = path(Math.max(0, t - 4));
  const b = path(t + 4);
  return mapPose((k) => (b[k] - a[k]) / 8);
}

/** Keyframes sampled once per display frame, played linearly. */
function keyframes(path: Trajectory, ms: number, render: (p: Pose) => Keyframe): Keyframe[] {
  const n = Math.max(2, Math.ceil(ms / 16));
  const out: Keyframe[] = [];
  for (let i = 0; i <= n; i++) out.push({ ...render(path((ms * i) / n)), offset: i / n });
  return out;
}

/** Recent poses, for the on-screen speed at the moment of release. */
class Recorder {
  private log: Array<{ t: number; p: Pose }> = [];

  reset(): void {
    this.log = [];
  }

  push(p: Pose): void {
    const t = performance.now();
    this.log.push({ t, p });
    while (this.log.length > 2 && t - this.log[0].t > VELOCITY_WINDOW_MS * 2) this.log.shift();
  }

  /** Per-ms speed over the last window; still if the pose hasn't moved lately. */
  velocity(): Pose {
    const now = performance.now();
    const last = this.log[this.log.length - 1];
    if (!last || now - last.t > VELOCITY_WINDOW_MS) return { ...STILL };
    let first = last;
    for (const e of this.log) {
      if (last.t - e.t <= VELOCITY_WINDOW_MS) {
        first = e;
        break;
      }
    }
    const dt = last.t - first.t;
    if (dt < 8) return { ...STILL };
    return mapPose((k) => (last.p[k] - first.p[k]) / dt);
  }
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
  private readonly rec = new Recorder();

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
    return this.rec.velocity();
  }

  /** Cancelled gesture: spring back to rest from the current pose and speed. */
  release(from: Pose = this.last, v: Pose = this.velocity()): void {
    const { path, ms } = spring(from, v, REST);
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
// Underlay: the screen a page lifts off from
// ---------------------------------------------------------------------------

/** Underlay state: its scale and the scrim's opacity, as one small "pose". */
function underPose(reveal: number, gone: boolean): Pose {
  return {
    ...REST,
    s: 0.9 + 0.1 * reveal,
    // Some dimming stays while the card is held so it floats above the screen
    // behind (both are dark); it clears only once the page has gone.
    o: gone ? 0 : 0.24 + (1 - reveal) * 0.36,
  };
}

/** The shell's content area: what a full-screen page covers. */
function shellContent(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-back-peek]');
}

/**
 * Pushed back and dimmed while covered, it comes forward and brightens as the
 * card shrinks away. One transform on the underlying screen plus one scrim whose
 * opacity moves; nothing else on screen is touched.
 */
class Underlay {
  private el: HTMLElement | null = null;
  private scrim: HTMLDivElement | null = null;
  private anims: Animation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: Pose = underPose(0, false);
  private playing: { path: Trajectory; ms: number; started: number } | null = null;
  private readonly rec = new Recorder();

  /**
   * The scrim goes right below the card, in the card's own stacking context
   * (same parent, same position type and z-index, inserted just before it), so
   * it dims everything under the card — and only that — whether the card is a
   * full-screen page on `<body>` or a page stacked inside a tab.
   */
  begin(under: HTMLElement | null, card: HTMLElement | null): void {
    this.cleanupNow();
    if (!under || !card?.parentElement) return;
    this.el = under;
    under.style.transition = 'none';
    under.style.willChange = 'transform';
    const cs = getComputedStyle(card);
    const scrim = document.createElement('div');
    scrim.dataset.backScrim = '';
    scrim.setAttribute('aria-hidden', 'true');
    scrim.style.cssText =
      `position:${cs.position === 'fixed' ? 'fixed' : 'absolute'};inset:0;z-index:${cs.zIndex};` +
      'background:#000;pointer-events:none;opacity:0;will-change:opacity;';
    card.parentElement.insertBefore(scrim, card);
    this.scrim = scrim;
    this.rec.reset();
    this.set(0);
  }

  /** `reveal` = eased finger travel; 0 = page fully covering. */
  set(reveal: number): void {
    this.apply(underPose(reveal, false));
    this.rec.push(this.last);
  }

  /** The page is leaving: settle at rest alongside its throw. */
  toRest(ms: number): void {
    const [from, v] = this.now();
    this.play(hermite(from, v, underPose(1, true), ms), ms);
  }

  /** The page came back (also mid-throw, when the layer declined): push back again. */
  toStart(): void {
    const [from, v] = this.now();
    const { path, ms } = spring(from, v, underPose(0, false));
    this.play(path, ms);
  }

  /** Pose and speed on screen right now — mid-animation if one is playing. */
  private now(): [Pose, Pose] {
    const p = this.playing;
    if (!p) return [this.last, this.rec.velocity()];
    const t = Math.min(performance.now() - p.started, p.ms);
    return [p.path(t), speedAt(p.path, t)];
  }

  private apply(p: Pose): void {
    if (!this.el || !this.scrim) return;
    this.last = p;
    this.el.style.transform = `scale(${p.s.toFixed(4)})`;
    this.scrim.style.opacity = p.o.toFixed(3);
  }

  private play(path: Trajectory, ms: number): void {
    const el = this.el;
    const scrim = this.scrim;
    if (!el || !scrim) return;
    this.stop();
    this.apply(path(ms));
    this.playing = { path, ms, started: performance.now() };
    if (typeof el.animate === 'function') {
      this.anims = [
        el.animate(keyframes(path, ms, (p) => ({ transform: `scale(${p.s})` })), {
          duration: ms,
          fill: 'forwards',
        }),
        scrim.animate(keyframes(path, ms, (p) => ({ opacity: p.o })), {
          duration: ms,
          fill: 'forwards',
        }),
      ];
    }
    this.timer = setTimeout(() => this.cleanupNow(), ms + 40);
  }

  private stop(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.anims.forEach((a) => a.cancel());
    this.anims = [];
    this.playing = null;
  }

  private cleanupNow(): void {
    this.stop();
    const el = this.el;
    this.el = null;
    if (el) {
      el.style.transition = '';
      el.style.willChange = '';
      el.style.transform = '';
    }
    this.scrim?.remove();
    this.scrim = null;
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
function cardPose(frame: BackGestureFrame, feel: BackFeel, amp: number): Pose {
  const w = viewportWidth();
  const h = viewportHeight();
  const dir = direction(frame.edge);
  const t = clamp(frame.dx / w, 0, 1);
  // Pitch and lift come in quickly, so a short swipe already feels held.
  const grip = ease(frame.dx / (w * 0.35));
  // Shrink and drift follow the reference the user picked (measured from its
  // frames): almost nothing for the first half of the swipe, then clearly
  // leaving — 0.93 / 0.82 / 0.70 and a drift of ~0 / 2.4% / 5.8% of the width
  // with the finger 50% / 69% / 87% across.
  const s = 1 - feel.shrink * amp * Math.pow(t, SHRINK_CURVE);
  const ry = dir * feel.turn * amp * ease(t / 0.55);
  const roomX = Math.max(0, (w * (1 - s)) / 2 + tiltInset((w * s) / 2, ry) - EDGE_MARGIN_PX);
  const x = dir * softLimit(w * feel.shift * amp * Math.pow(t, DRIFT_CURVE), roomX);
  // Finger height, -1 (top) … 1 (bottom); full strength well before the edge.
  const fy = clamp((frame.y - h / 2) / (h * 0.32), -1, 1);
  const rx = -fy * feel.pitch * amp * grip;
  const roomY = Math.min(feel.lift * amp, Math.max(0, (h * (1 - s)) / 2 - EDGE_MARGIN_PX));
  const y = softLimit(frame.dy * 0.35, roomY) * grip;
  return { x, y, s, rx, ry, o: 1 };
}

/**
 * Where a thrown card ends up: further along, turned toward edge-on, small.
 * Opacity is left alone here — the fade is laid over the throw separately
 * ({@link fadingOut}) so it can come late.
 */
function throwTarget(p: Pose, dir: number, feel: BackFeel, amp: number): Pose {
  return {
    // Small, like the drift while held: the card leaves by shrinking and turning.
    x: p.x + dir * viewportWidth() * feel.shift * amp,
    y: p.y + viewportHeight() * 0.03 * amp,
    s: Math.min(p.s, feel.exitScale + (1 - feel.exitScale) * (1 - amp)),
    rx: p.rx * 1.25,
    ry: dir * feel.exitTurn * amp,
    o: p.o,
  };
}

function throwMs(feel: BackFeel): number {
  return clamp(feel.exitMs, 120, MAX_THROW_MS);
}

/**
 * Full-screen (or tab-stacked) sub-page: a card held by the finger, thrown off
 * on commit. `getUnder` is the screen it covers — by default the shell's
 * content area, for a page stacked inside a tab the screen beneath it.
 */
export function pageBackPreview(
  getEl: () => HTMLElement | null,
  getUnder: () => HTMLElement | null = shellContent,
): BackPreview {
  const page = new Surface(getEl, 'page');
  const under = new Underlay();
  let feel = getBackFeel();
  let dir = 1;
  return {
    start(edge) {
      feel = getBackFeel();
      dir = direction(edge);
      page.begin();
      under.begin(getUnder(), page.element);
    },
    update(frame) {
      dir = direction(frame.edge);
      page.set(cardPose(frame, feel, 1));
      under.set(travel(frame, 0.7));
    },
    cancel() {
      page.release();
      under.toStart();
    },
    commit() {
      const ms = throwMs(feel);
      const from = page.pose;
      const path = fadingOut(hermite(from, page.velocity(), throwTarget(from, dir, feel, 1), ms), ms, 0.4);
      page.throwOff(path, ms, () => under.toStart());
      under.toRest(ms);
    },
  };
}

/** Bottom sheet: sink, tip back, turn toward the swipe; thrown down on commit. */
export function sheetBackPreview(
  getSheet: () => HTMLElement | null,
  getBackdrop: () => HTMLElement | null,
): BackPreview {
  const sheet = new Surface(getSheet, 'sheet', '50% 100%');
  const backdrop = new Surface(getBackdrop, 'fade');
  let feel = getBackFeel();
  let dir = 1;
  let height = 400;
  return {
    start(edge) {
      feel = getBackFeel();
      dir = direction(edge);
      sheet.begin();
      backdrop.begin();
      // One layout read per gesture: how far the sheet may sink.
      height = sheet.element?.getBoundingClientRect().height || height;
    },
    update(frame) {
      dir = direction(frame.edge);
      const e = travel(frame, 0.5);
      sheet.set({
        x: dir * e * 24,
        y: e * Math.min(height * 0.25, 180),
        s: 1 - e * 0.1,
        // The top edge falls away; the side the finger heads for sinks.
        rx: e * feel.pitch * 0.7,
        ry: dir * e * feel.turn * 0.35,
        o: 1,
      });
      backdrop.set({ ...REST, o: 1 - e * 0.6 });
    },
    cancel() {
      sheet.release();
      backdrop.release();
    },
    commit() {
      const ms = throwMs(feel);
      const from = sheet.pose;
      const to = { ...from, y: height + 48, rx: from.rx + 10 };
      sheet.throwOff(hermite(from, sheet.velocity(), to, ms), ms);
      const fade = backdrop.pose;
      backdrop.throwOff(hermite(fade, backdrop.velocity(), { ...fade, o: 0 }, ms), ms);
    },
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
