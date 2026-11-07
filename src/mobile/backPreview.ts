/**
 * Predictive-back previews for the mobile shell's shared layer kinds.
 *
 * `backHandler.ts` decides *when* a gesture is in flight and hands each frame
 * to the topmost layer's {@link BackPreview}; this file decides *what that
 * looks like*. Three poses cover every layer in the app:
 *
 * - **page** (`MobileFullscreenPage`): the page turns into a card pinned under
 *   the finger — it slides with it, shrinks, swings toward the viewer on the
 *   finger's side (with light falling across it so the tilt reads even on a dark
 *   page), while the screen underneath slides in from the side out of a dimming
 *   scrim. Let go and the card is flung off screen at the finger's speed.
 * - **sheet** (`MobileSheet`): the sheet sinks, tightens and tips back toward
 *   the finger's side while its backdrop thins out.
 * - **peek** (in-page navigation such as "up one folder", settings sub-pages,
 *   the tab fallback): there is no overlay to peel away, so the content area
 *   drifts after the finger and fades; on commit the previous content slides in
 *   from the other side.
 *
 * Horizontal motion follows the raw finger travel (`frame.dx`), not the
 * system's progress: progress is spring-smoothed by the system and lags, which
 * is exactly what makes a preview feel "not attached".
 *
 * ## Cost: compositor properties only
 * Every per-frame write is a `transform` or an `opacity` on a handful of
 * elements — both are animated on the GPU without layout or paint. Anything
 * that would repaint a screen-sized layer each frame is deliberately kept
 * constant for the whole gesture instead: the page's corner radius and its
 * shadow are fixed from the first frame (the display's own rounded corners hide
 * the radius at rest), the dimming is a separate scrim and the lighting a
 * separate shade, both of which only change opacity — never a CSS `filter`. The
 * pose is written straight into `style.transform` rather than into custom
 * properties: a custom property is inherited, so changing one on a page root
 * would restyle the page's whole subtree each frame.
 *
 * The one place custom properties are used is at commit: `--back-*` records the
 * pose the finger let go at (plus direction and fling duration), so the layer's
 * exit keyframes (`[data-back].mobile-*-exit` in globals.css) continue from
 * exactly there.
 */

import type { BackEdge, BackGestureFrame, BackPreview } from './backHandler';

/** Settling back after a cancelled gesture. Same curve as `--spring-smooth`. */
const RELEASE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const RELEASE_MS = 380;
/**
 * Fling after a commit: starts at {@link FLING_SLOPE}× the average speed and
 * decelerates, so the layer leaves at the speed the finger let go with. The
 * page's exit keyframes in globals.css use the same curve.
 */
const FLING_EASING = 'cubic-bezier(0.25, 0.8, 0.3, 1)';
const FLING_SLOPE = 0.8 / 0.25;
const FLING_MIN_MS = 200;
const FLING_MAX_MS = 360;
/** Sheets always sink at one pace (short travel, a varying duration looks random). */
const SHEET_EXIT_MS = 300;
/** Peek commit: old content fades out this fast before the previous one slides in. */
const PEEK_SWAP_OUT_MS = 80;
/**
 * After a commit the layer gets this long to start its own exit animation. If it
 * has not (a "discard changes?" confirm, a handler that declined), the layer is
 * still on screen in a half-shrunk pose and must spring back.
 */
const COMMIT_GRACE_MS = 220;
/** Depth of the 3D effect: larger = flatter. Same value as in globals.css. */
const PERSPECTIVE_PX = 1000;
/** Where the page card ends up after a commit, in viewport widths (fully off screen). */
const PAGE_FLING_VW = 1.08;

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
  /** opacity; omitted = leave alone */
  o?: number;
}

const REST: Pose = { x: 0, y: 0, s: 1, rx: 0, ry: 0 };

/** Decelerating response: the first part of the swipe already reads clearly. */
function ease(t: number): number {
  const c = clamp(t, 0, 1);
  return 1 - (1 - c) * (1 - c);
}

function direction(edge: BackEdge): number {
  return edge === 'left' ? 1 : -1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function viewportWidth(): number {
  return window.innerWidth || 1;
}

/** Finger travel as a share of `span` viewport widths, eased (0 … 1). */
function travel(frame: BackGestureFrame, span: number): number {
  return ease(frame.dx / (viewportWidth() * span));
}

/**
 * Finger height as -1 (top of the viewport) … 1 (bottom). The tilt follows where
 * the finger is, not how far it has travelled.
 */
function fingerHeight(frame: BackGestureFrame): number {
  const h = window.innerHeight || 1;
  return clamp((frame.y / h) * 2 - 1, -1, 1);
}

/** Duration that makes a fling of `distance` px start at `speed` px/s. */
function flingMs(distance: number, speed: number): number {
  if (!(speed > 0)) return FLING_MAX_MS;
  return clamp((FLING_SLOPE * distance * 1000) / speed, FLING_MIN_MS, FLING_MAX_MS);
}

/**
 * The function list here must match the exit keyframes in globals.css exactly
 * (perspective, translate3d, rotateX, rotateY, scale), or the browser falls back
 * to interpolating matrices when the exit animation takes over.
 */
function poseTransform(p: Pose): string {
  return (
    `perspective(${PERSPECTIVE_PX}px) translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) ` +
    `rotateX(${p.rx.toFixed(2)}deg) rotateY(${p.ry.toFixed(2)}deg) scale(${p.s.toFixed(4)})`
  );
}

function isExiting(el: HTMLElement): boolean {
  const anims = el.getAnimations?.();
  if (anims) {
    return anims.some((a) => /Exit$/.test((a as CSSAnimation).animationName ?? ''));
  }
  return /exit/.test(el.className);
}

/**
 * Light across a tilted card: the edge lifted toward the viewer catches a faint
 * highlight, the far edge falls into shadow. Without it a dark page turning in
 * 3D just looks like a page getting narrower. It is a child of the card, so it
 * rides along with every transform (including the exit fling) for free.
 */
function createShade(dir: number): HTMLDivElement {
  const shade = document.createElement('div');
  shade.dataset.backShade = '';
  shade.setAttribute('aria-hidden', 'true');
  const toward = dir > 0 ? 'to right' : 'to left';
  shade.style.cssText =
    'position:absolute;inset:0;z-index:2147483647;pointer-events:none;' +
    'border-radius:inherit;opacity:0;will-change:opacity;' +
    `background:linear-gradient(${toward},rgb(255 255 255/0.07),rgb(255 255 255/0) 28%,` +
    'rgb(0 0 0/0) 48%,rgb(0 0 0/0.46));';
  return shade;
}

/**
 * Owns one element's pose for the duration of a gesture and restores it
 * afterwards. Never touches `className` (React owns it) — only `data-back`,
 * inline style, which React does not render, and an optional shade child that
 * is removed again on cleanup.
 */
class Surface {
  private el: HTMLElement | null = null;
  private shade: HTMLDivElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: Pose = REST;
  private touchedOpacity = false;

  constructor(
    private readonly resolve: () => HTMLElement | null,
    private readonly kind: SurfaceKind,
    private readonly origin?: string,
  ) {}

  /** The pose currently written (REST when idle). */
  get pose(): Pose {
    return this.last;
  }

  get element(): HTMLElement | null {
    return this.el;
  }

  begin(): void {
    this.clearTimer();
    // A previous gesture's settle animation may still be running: finish it now.
    this.cleanup();
    const el = this.resolve();
    if (!el) return;
    // The entrance animation fills `forwards`, and an animation outranks inline
    // style — left alone it would pin the element and swallow our pose. Cancelling
    // a CSS animation is permanent until its `animation-name` changes, so the
    // enter class cannot replay when we clean up; the exit class still starts
    // fresh from the pose we leave behind.
    for (const a of el.getAnimations?.() ?? []) {
      if (/Enter$/.test((a as CSSAnimation).animationName ?? '')) a.cancel();
    }
    this.el = el;
    this.last = REST;
    el.dataset.back = this.kind;
    el.style.transition = 'none';
    el.style.willChange = 'transform, opacity';
    if (this.origin) el.style.transformOrigin = this.origin;
  }

  /** Add the lighting shade (see {@link createShade}); `dir` = side the finger came from. */
  addShade(dir: number): void {
    if (!this.el || this.shade) return;
    this.shade = createShade(dir);
    this.el.appendChild(this.shade);
  }

  set(pose: Pose, shade?: number): void {
    const el = this.el;
    if (!el) return;
    this.last = pose;
    el.style.transform = poseTransform(pose);
    if (pose.o !== undefined) {
      this.touchedOpacity = true;
      el.style.opacity = pose.o.toFixed(3);
    }
    if (shade !== undefined && this.shade) this.shade.style.opacity = shade.toFixed(3);
  }

  /** Animate back to rest, then drop every trace of the gesture. */
  release(): void {
    const el = this.el;
    if (!el) return;
    this.clearTimer();
    const t = `${RELEASE_MS}ms ${RELEASE_EASING}`;
    el.style.transition = `transform ${t}, opacity ${t}`;
    if (this.shade) this.shade.style.transition = `opacity ${t}`;
    this.set({ ...REST, o: this.touchedOpacity ? 1 : undefined }, 0);
    this.timer = setTimeout(() => this.cleanup(), RELEASE_MS + 60);
  }

  /**
   * Commit: the layer's own exit animation is about to take over from this pose.
   * Record the pose for its keyframes, then stay out of its way — unless it never
   * starts, in which case spring back (and tell the caller, so companions such
   * as the underlay can follow).
   */
  handOff(fling: { dir: number; ms: number }, onRevert?: () => void): void {
    const el = this.el;
    if (!el) return;
    this.clearTimer();
    const p = this.last;
    const s = el.style;
    s.setProperty('--back-x', `${p.x.toFixed(2)}px`);
    s.setProperty('--back-y', `${p.y.toFixed(2)}px`);
    s.setProperty('--back-s', p.s.toFixed(4));
    s.setProperty('--back-rx', `${p.rx.toFixed(2)}deg`);
    s.setProperty('--back-ry', `${p.ry.toFixed(2)}deg`);
    s.setProperty('--back-dir', String(fling.dir));
    s.setProperty('--back-ms', `${Math.round(fling.ms)}ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!el.isConnected) return this.cleanup();
      if (isExiting(el)) return;
      this.release();
      onRevert?.();
    }, COMMIT_GRACE_MS);
  }

  /**
   * Commit for in-place navigation: the content under this element is being
   * swapped right now (by the layer's close), at a moment we cannot observe.
   * Fade the old content out where it is, then slide whatever is there by then
   * in from the opposite side — reads as "the previous page comes back".
   */
  swapIn(dir: number): void {
    const el = this.el;
    if (!el) return;
    this.clearTimer();
    el.style.transition = `opacity ${PEEK_SWAP_OUT_MS}ms linear`;
    this.set({ ...this.last, o: 0 });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!el.isConnected) return this.cleanup();
      el.style.transition = 'none';
      this.set({ x: -dir * 40, y: 0, s: 0.97, rx: 0, ry: -dir * 5, o: 0 });
      // Commit the start pose before turning transitions back on.
      void el.offsetWidth;
      el.style.transition = `transform ${RELEASE_MS}ms ${RELEASE_EASING}, opacity 220ms ease-out`;
      this.set({ ...REST, o: 1 });
      this.timer = setTimeout(() => this.cleanup(), RELEASE_MS + 60);
    }, PEEK_SWAP_OUT_MS);
  }

  private cleanup(): void {
    this.clearTimer();
    this.shade?.remove();
    this.shade = null;
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
    if (this.touchedOpacity) s.opacity = '';
    this.touchedOpacity = false;
    for (const v of ['x', 'y', 's', 'rx', 'ry', 'dir', 'ms']) s.removeProperty(`--back-${v}`);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * The screen a page is peeled away from. It starts well to the side, pushed
 * back and dimmed, and slides to rest as the page leaves — the cheapest
 * convincing parallax: one transform on `<main>` plus one scrim whose opacity
 * moves. Nothing else on screen is touched.
 */
class Underlay {
  private el: HTMLElement | null = null;
  private scrim: HTMLDivElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  begin(): void {
    this.clearTimer();
    this.cleanupNow();
    const el = document.querySelector<HTMLElement>('[data-back-peek]');
    if (!el) return;
    this.el = el;
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    const scrim = document.createElement('div');
    scrim.dataset.backScrim = '';
    scrim.setAttribute('aria-hidden', 'true');
    scrim.style.cssText =
      'position:fixed;inset:0;z-index:49;background:#000;pointer-events:none;opacity:0;will-change:opacity;';
    document.body.appendChild(scrim);
    this.scrim = scrim;
  }

  /** `e` = eased reveal; 0 = page fully covering, 1 = page gone. */
  set(e: number, dir: number): void {
    if (!this.el || !this.scrim) return;
    const x = -dir * (1 - e) * viewportWidth() * 0.22;
    this.el.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0) scale(${(0.92 + 0.08 * e).toFixed(4)})`;
    this.scrim.style.opacity = ((1 - e) * 0.6).toFixed(3);
  }

  /** The page is leaving: the screen underneath settles at rest alongside it. */
  toRest(ms: number): void {
    if (!this.el || !this.scrim) return;
    this.clearTimer();
    const t = `${Math.round(ms)}ms ${FLING_EASING}`;
    this.el.style.transition = `transform ${t}`;
    this.scrim.style.transition = `opacity ${t}`;
    this.el.style.transform = 'translate3d(0, 0, 0) scale(1)';
    this.scrim.style.opacity = '0';
    this.timer = setTimeout(() => this.cleanupNow(), ms + 60);
  }

  /** The page came back: slide the screen underneath back out of view. */
  toStart(dir: number): void {
    if (!this.el || !this.scrim) return;
    this.clearTimer();
    const t = `${RELEASE_MS}ms ${RELEASE_EASING}`;
    this.el.style.transition = `transform ${t}`;
    this.scrim.style.transition = `opacity ${t}`;
    this.set(0, dir);
    this.timer = setTimeout(() => this.cleanupNow(), RELEASE_MS + 60);
  }

  private cleanupNow(): void {
    this.clearTimer();
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

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Full-screen sub-page: a card pinned under the finger, flung off on commit. */
export function pageBackPreview(getEl: () => HTMLElement | null): BackPreview {
  const page = new Surface(getEl, 'page');
  const under = new Underlay();
  let dir = 1;
  let velocity = 0;
  return {
    start(edge) {
      dir = direction(edge);
      velocity = 0;
      page.begin();
      page.addShade(dir);
      under.begin();
      under.set(0, dir);
    },
    update(frame) {
      dir = direction(frame.edge);
      velocity = frame.velocity;
      // Shape (shrink / tilt / light) is fully developed by ~55% of the width;
      // position keeps following the finger beyond that.
      const e = travel(frame, 0.55);
      page.set(
        {
          // Slightly behind the finger, like dragging something with a little weight.
          x: dir * frame.dx * 0.78,
          // Vertical follow fades in with the swipe so a tiny wobble at the very
          // start of the gesture doesn't make the page twitch.
          y: clamp(frame.dy * 0.3, -56, 56) * Math.min(1, e * 2.5),
          s: 1 - e * 0.13,
          // Lifted by the edge the finger came from: that side comes toward the
          // viewer, the far side recedes. Height tips it toward the finger too.
          ry: dir * e * 14,
          rx: fingerHeight(frame) * e * 5,
        },
        e,
      );
      under.set(travel(frame, 0.8), dir);
    },
    cancel() {
      page.release();
      under.toStart(dir);
    },
    commit() {
      const remaining = Math.abs(dir * viewportWidth() * PAGE_FLING_VW - page.pose.x);
      const ms = flingMs(remaining, velocity);
      page.handOff({ dir, ms }, () => under.toStart(dir));
      under.toRest(ms);
    },
  };
}

/** Bottom sheet: sink, tighten and tip back toward the finger; thin the backdrop. */
export function sheetBackPreview(
  getSheet: () => HTMLElement | null,
  getBackdrop: () => HTMLElement | null,
): BackPreview {
  const sheet = new Surface(getSheet, 'sheet', '50% 100%');
  const backdrop = new Surface(getBackdrop, 'fade');
  let dir = 1;
  let height = 400;
  return {
    start(edge) {
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
        x: dir * e * 22,
        y: e * Math.min(height * 0.22, 160),
        s: 1 - e * 0.08,
        // Top edge falls away from the viewer; the finger's side comes forward.
        rx: e * 7,
        ry: dir * e * 6,
      });
      backdrop.set({ ...REST, o: 1 - e * 0.65 });
    },
    cancel() {
      sheet.release();
      backdrop.release();
    },
    commit() {
      sheet.handOff({ dir, ms: SHEET_EXIT_MS });
      backdrop.handOff({ dir, ms: SHEET_EXIT_MS });
    },
  };
}

/**
 * In-page navigation (no overlay to peel away): the content area drifts after
 * the finger and fades. The target is any element marked `data-back-peek` —
 * currently the shell's `<main>` — so every layer of this kind shares one pose
 * and one rule. On commit the previous content slides in from the other side.
 */
export function peekBackPreview(): BackPreview {
  const surface = new Surface(
    () => document.querySelector<HTMLElement>('[data-back-peek]'),
    'peek',
  );
  let dir = 1;
  return {
    start(edge) {
      dir = direction(edge);
      surface.begin();
    },
    update(frame) {
      dir = direction(frame.edge);
      const e = travel(frame, 0.6);
      surface.set({
        x: dir * frame.dx * 0.32,
        y: 0,
        s: 1 - e * 0.05,
        rx: 0,
        ry: dir * e * 6,
        o: 1 - e * 0.45,
      });
    },
    cancel: () => surface.release(),
    commit: () => surface.swapIn(dir),
  };
}
