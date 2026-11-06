/**
 * Predictive-back previews for the mobile shell's shared layer kinds.
 *
 * `backHandler.ts` decides *when* a gesture is in flight and hands each display
 * frame to the topmost layer's {@link BackPreview}; this file decides *what that
 * looks like*. Three poses cover every layer in the app:
 *
 * - **page** (`MobileFullscreenPage`): the page shrinks, rounds its corners and
 *   drifts after the finger, revealing what is underneath.
 * - **sheet** (`MobileSheet`): the sheet sinks and tightens a little while its
 *   backdrop thins out, so the screen behind "wakes up".
 * - **peek** (in-page navigation such as "up one folder", settings sub-pages,
 *   the tab fallback): there is no overlay to peel away, so the whole content
 *   area recedes a few pixels toward the finger and springs back on release.
 *
 * Pose lives in CSS custom properties (`--back-*`) on the element and the rules
 * in globals.css (`[data-back]`) turn them into a transform. One source of
 * truth means the layer's *exit* keyframes (`[data-back].mobile-*-exit`) can
 * continue from exactly the pose the user let go at.
 */

import type { BackEdge, BackGestureFrame, BackPreview } from "./backHandler";

/** Same curve as `--spring-smooth` in globals.css. */
const RELEASE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const RELEASE_MS = 340;
/**
 * After a commit the layer gets this long to start its own exit animation. If it
 * has not (a "discard changes?" confirm, a handler that declined), the layer is
 * still on screen in a half-shrunk pose and must spring back.
 */
const COMMIT_GRACE_MS = 220;

type SurfaceKind = "page" | "sheet" | "fade" | "peek";

interface Pose {
  /** translate, px */
  x: number;
  y: number;
  /** scale */
  s: number;
  /** corner radius, px (page / peek only) */
  r: number;
  /** opacity */
  o: number;
  /** 0–1 emphasis, drives the page's edge shadow */
  p: number;
}

const REST: Pose = { x: 0, y: 0, s: 1, r: 0, o: 1, p: 0 };

/** Decelerating response: the first part of the swipe already reads clearly. */
function ease(progress: number): number {
  const t = Math.min(Math.max(progress, 0), 1);
  return 1 - (1 - t) * (1 - t);
}

function direction(edge: BackEdge): number {
  return edge === "left" ? 1 : -1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function isExiting(el: HTMLElement): boolean {
  const anims = el.getAnimations?.();
  if (anims) {
    return anims.some((a) =>
      /Exit$/.test((a as CSSAnimation).animationName ?? ""),
    );
  }
  return /exit/.test(el.className);
}

/**
 * Owns one element's pose for the duration of a gesture and restores it
 * afterwards. Never touches `className` (React owns it) — only `data-back` and
 * inline custom properties, which React does not render.
 */
class Surface {
  private el: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

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
      if (/Enter$/.test((a as CSSAnimation).animationName ?? "")) a.cancel();
    }
    this.el = el;
    el.dataset.back = this.kind;
    el.style.transition = "none";
    el.style.willChange = "transform, opacity";
    if (this.origin) el.style.transformOrigin = this.origin;
  }

  set(pose: Pose): void {
    const el = this.el;
    if (!el) return;
    const s = el.style;
    s.setProperty("--back-x", `${pose.x.toFixed(2)}px`);
    s.setProperty("--back-y", `${pose.y.toFixed(2)}px`);
    s.setProperty("--back-s", pose.s.toFixed(4));
    s.setProperty("--back-r", `${pose.r.toFixed(2)}px`);
    s.setProperty("--back-o", pose.o.toFixed(3));
    s.setProperty("--back-p", pose.p.toFixed(3));
  }

  /** Animate back to rest, then drop every trace of the gesture. */
  release(): void {
    const el = this.el;
    if (!el) return;
    this.clearTimer();
    el.style.transition = [
      `transform ${RELEASE_MS}ms ${RELEASE_EASING}`,
      `border-radius ${RELEASE_MS}ms ${RELEASE_EASING}`,
      `opacity ${RELEASE_MS}ms ${RELEASE_EASING}`,
      `box-shadow ${RELEASE_MS}ms ${RELEASE_EASING}`,
    ].join(", ");
    this.set(REST);
    this.timer = setTimeout(() => this.cleanup(), RELEASE_MS + 60);
  }

  /**
   * Commit: the layer's own exit animation is about to take over from this pose.
   * Stay out of its way — unless it never starts, in which case spring back.
   */
  handOff(): void {
    const el = this.el;
    if (!el) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!el.isConnected) return this.cleanup();
      if (isExiting(el)) return;
      this.release();
    }, COMMIT_GRACE_MS);
  }

  private cleanup(): void {
    this.clearTimer();
    const el = this.el;
    this.el = null;
    if (!el) return;
    delete el.dataset.back;
    const s = el.style;
    s.transition = "";
    s.willChange = "";
    s.transformOrigin = "";
    for (const v of ["x", "y", "s", "r", "o", "p"])
      s.removeProperty(`--back-${v}`);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Full-screen sub-page: shrink, round, follow the finger. */
export function pageBackPreview(getEl: () => HTMLElement | null): BackPreview {
  const surface = new Surface(getEl, "page");
  return {
    start: () => surface.begin(),
    update({ progress, edge, dy }: BackGestureFrame) {
      const e = ease(progress);
      surface.set({
        x: direction(edge) * e * 22,
        // Vertical follow fades in with the swipe so a tiny wobble at the very
        // start of the gesture doesn't make the page twitch.
        y: clamp(dy * 0.16, -34, 34) * Math.min(1, e * 2.5),
        s: 1 - e * 0.12,
        r: e * 26,
        o: 1,
        p: e,
      });
    },
    cancel: () => surface.release(),
    commit: () => surface.handOff(),
  };
}

/** Bottom sheet: sink and tighten, thin the backdrop. */
export function sheetBackPreview(
  getSheet: () => HTMLElement | null,
  getBackdrop: () => HTMLElement | null,
): BackPreview {
  const sheet = new Surface(getSheet, "sheet", "50% 100%");
  const backdrop = new Surface(getBackdrop, "fade");
  return {
    start() {
      sheet.begin();
      backdrop.begin();
    },
    update({ progress }: BackGestureFrame) {
      const e = ease(progress);
      sheet.set({ ...REST, y: e * 14, s: 1 - e * 0.06 });
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
    () => document.querySelector<HTMLElement>("[data-back-peek]"),
    "peek",
  );
  return {
    start: () => surface.begin(),
    update({ progress, edge }: BackGestureFrame) {
      const e = ease(progress);
      surface.set({
        x: direction(edge) * e * 18,
        y: 0,
        s: 1 - e * 0.03,
        r: e * 22,
        o: 1 - e * 0.3,
        p: 0,
      });
    },
    cancel: () => surface.release(),
    commit: () => surface.release(),
  };
}
