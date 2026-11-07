/**
 * Predictive-back previews for the mobile shell's shared layer kinds.
 *
 * `backHandler.ts` decides *when* a gesture is in flight and hands each frame
 * to the topmost layer's {@link BackPreview}; this file decides *what that
 * looks like*. Three poses cover every layer in the app:
 *
 * - **page** (`MobileFullscreenPage`): the page shrinks, tilts in 3D toward the
 *   finger and drifts after it, while the screen underneath slides in from the
 *   side (parallax) out of a dimming scrim.
 * - **sheet** (`MobileSheet`): the sheet sinks, tightens and tips back a little
 *   while its backdrop thins out, so the screen behind "wakes up".
 * - **peek** (in-page navigation such as "up one folder", settings sub-pages,
 *   the tab fallback): there is no overlay to peel away, so the whole content
 *   area recedes a few pixels toward the finger and springs back on release.
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
 *
 * The one place custom properties are used is at commit: `--back-*` records the
 * pose the finger let go at, so the layer's exit keyframes
 * (`[data-back].mobile-*-exit` in globals.css) can continue from exactly there.
 */

import type { BackEdge, BackGestureFrame, BackPreview } from './backHandler';

/** Same curve as `--spring-smooth` in globals.css. */
const RELEASE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const RELEASE_MS = 340;
/** Commit tail for the screen underneath: matches the page's exit animation. */
const UNDERLAY_COMMIT_MS = 260;
const UNDERLAY_COMMIT_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
/**
 * After a commit the layer gets this long to start its own exit animation. If it
 * has not (a "discard changes?" confirm, a handler that declined), the layer is
 * still on screen in a half-shrunk pose and must spring back.
 */
const COMMIT_GRACE_MS = 220;
/** Depth of the 3D effect: larger = flatter. Same value as in globals.css. */
const PERSPECTIVE_PX = 1100;

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
function ease(progress: number): number {
  const t = Math.min(Math.max(progress, 0), 1);
  return 1 - (1 - t) * (1 - t);
}

function direction(edge: BackEdge): number {
  return edge === 'left' ? 1 : -1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Finger height as -1 (top of the viewport) … 1 (bottom). The tilt follows where
 * the finger is, not how far it has travelled.
 */
function fingerHeight(frame: BackGestureFrame): number {
  const h = window.innerHeight || 1;
  return clamp((frame.y / h) * 2 - 1, -1, 1);
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
 * Owns one element's pose for the duration of a gesture and restores it
 * afterwards. Never touches `className` (React owns it) — only `data-back` and
 * inline style, which React does not render.
 */
class Surface {
  private el: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: Pose = REST;
  private touchedOpacity = false;

  constructor(
    private readonly resolve: () => HTMLElement | null,
    private readonly kind: SurfaceKind,
    private readonly origin?: string,
  ) {}

  begin(): void {
    this.clearTimer();
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

  set(pose: Pose): void {
    const el = this.el;
    if (!el) return;
    this.last = pose;
    el.style.transform = poseTransform(pose);
    if (pose.o !== undefined) {
      this.touchedOpacity = true;
      el.style.opacity = pose.o.toFixed(3);
    }
  }

  /** Animate back to rest, then drop every trace of the gesture. */
  release(): void {
    const el = this.el;
    if (!el) return;
    this.clearTimer();
    el.style.transition = `transform ${RELEASE_MS}ms ${RELEASE_EASING}, opacity ${RELEASE_MS}ms ${RELEASE_EASING}`;
    this.set({ ...REST, o: this.touchedOpacity ? 1 : undefined });
    this.timer = setTimeout(() => this.cleanup(), RELEASE_MS + 60);
  }

  /**
   * Commit: the layer's own exit animation is about to take over from this pose.
   * Record the pose for its keyframes, then stay out of its way — unless it never
   * starts, in which case spring back (and tell the caller, so companions such
   * as the underlay can follow).
   */
  handOff(onRevert?: () => void): void {
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
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!el.isConnected) return this.cleanup();
      if (isExiting(el)) return;
      this.release();
      onRevert?.();
    }, COMMIT_GRACE_MS);
  }

  private cleanup(): void {
    this.clearTimer();
    const el = this.el;
    this.el = null;
    if (!el) return;
    delete el.dataset.back;
    const s = el.style;
    s.transition = '';
    s.willChange = '';
    s.transformOrigin = '';
    s.transform = '';
    if (this.touchedOpacity) s.opacity = '';
    this.touchedOpacity = false;
    for (const v of ['x', 'y', 's', 'rx', 'ry']) s.removeProperty(`--back-${v}`);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * The screen a page is peeled away from. It starts a little to the side,
 * pushed back and dimmed, and eases to rest as the page leaves — the cheapest
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

  /** `e` = eased progress; 0 = page fully covering, 1 = page gone. */
  set(e: number, dir: number): void {
    if (!this.el || !this.scrim) return;
    this.el.style.transform = `translate3d(${(-dir * (1 - e) * 36).toFixed(2)}px, 0, 0) scale(${(0.94 + 0.06 * e).toFixed(4)})`;
    this.scrim.style.opacity = ((1 - e) * 0.5).toFixed(3);
  }

  /** The page is leaving: the screen underneath settles at rest alongside it. */
  toRest(): void {
    if (!this.el || !this.scrim) return;
    this.clearTimer();
    const t = `${UNDERLAY_COMMIT_MS}ms ${UNDERLAY_COMMIT_EASING}`;
    this.el.style.transition = `transform ${t}`;
    this.scrim.style.transition = `opacity ${t}`;
    this.el.style.transform = 'translate3d(0, 0, 0) scale(1)';
    this.scrim.style.opacity = '0';
    this.timer = setTimeout(() => this.cleanupNow(), UNDERLAY_COMMIT_MS + 60);
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

/** Full-screen sub-page: shrink, tilt toward the finger, peel off the screen beneath. */
export function pageBackPreview(getEl: () => HTMLElement | null): BackPreview {
  const page = new Surface(getEl, 'page');
  const under = new Underlay();
  let dir = 1;
  return {
    start(edge) {
      dir = direction(edge);
      page.begin();
      under.begin();
    },
    update(frame) {
      const e = ease(frame.progress);
      dir = direction(frame.edge);
      page.set({
        x: dir * e * 26,
        // Vertical follow fades in with the swipe so a tiny wobble at the very
        // start of the gesture doesn't make the page twitch.
        y: clamp(frame.dy * 0.16, -34, 34) * Math.min(1, e * 2.5),
        s: 1 - e * 0.1,
        // Lifted by the edge the finger came from: that side comes toward the
        // viewer, the far side recedes. Height tips it toward the finger too.
        ry: dir * e * 9,
        rx: fingerHeight(frame) * e * 4.5,
      });
      under.set(e, dir);
    },
    cancel() {
      page.release();
      under.toStart(dir);
    },
    commit() {
      page.handOff(() => under.toStart(dir));
      under.toRest();
    },
  };
}

/** Bottom sheet: sink, tighten and tip back; thin the backdrop. */
export function sheetBackPreview(
  getSheet: () => HTMLElement | null,
  getBackdrop: () => HTMLElement | null,
): BackPreview {
  const sheet = new Surface(getSheet, 'sheet', '50% 100%');
  const backdrop = new Surface(getBackdrop, 'fade');
  return {
    start() {
      sheet.begin();
      backdrop.begin();
    },
    update(frame) {
      const e = ease(frame.progress);
      sheet.set({ ...REST, y: e * 12, s: 1 - e * 0.05, rx: -e * 3 });
      backdrop.set({ ...REST, o: 1 - e * 0.5 });
    },
    cancel() {
      sheet.release();
      backdrop.release();
    },
    commit() {
      sheet.handOff();
      backdrop.handOff();
    },
  };
}

/**
 * In-page navigation (no overlay to peel away): the content area recedes toward
 * the finger. The target is any element marked `data-back-peek` — currently the
 * shell's `<main>` — so every layer of this kind shares one pose and one rule.
 *
 * On commit the layer's state change has already swapped the content in; the
 * spring back then reads as the previous page settling into place.
 */
export function peekBackPreview(): BackPreview {
  const surface = new Surface(
    () => document.querySelector<HTMLElement>('[data-back-peek]'),
    'peek',
  );
  return {
    start: () => surface.begin(),
    update(frame) {
      const e = ease(frame.progress);
      const dir = direction(frame.edge);
      surface.set({
        x: dir * e * 18,
        y: 0,
        s: 1 - e * 0.03,
        rx: 0,
        ry: dir * e * 4,
        o: 1 - e * 0.3,
      });
    },
    cancel: () => surface.release(),
    commit: () => surface.release(),
  };
}
