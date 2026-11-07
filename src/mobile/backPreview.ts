/**
 * Predictive-back previews for the mobile shell's shared layer kinds.
 *
 * `backHandler.ts` decides *when* a gesture is in flight and hands each frame
 * to the topmost layer's {@link BackPreview}; this file decides *what that
 * looks like*. Three poses cover every layer in the app:
 *
 * - **page** (`MobileFullscreenPage`): the page lifts off into a rounded card
 *   that floats *inside* the screen. The further the finger travels the smaller
 *   it gets; it drifts a little after the finger, and it tilts as if the finger
 *   were pressing on it — the part nearest the finger sinks away. The screen
 *   underneath comes forward out of a dimming scrim. On commit the card keeps
 *   shrinking and fades out where it is.
 * - **sheet** (`MobileSheet`): the sheet sinks, tightens and tips back while its
 *   backdrop thins out.
 * - **peek** (in-page navigation such as "up one folder", settings sub-pages,
 *   the tab fallback): there is no overlay to peel away, so the content area
 *   recedes the same way, more gently; on commit the previous content slides in
 *   from the other side.
 *
 * Motion follows the raw finger position (`frame.dx` / `frame.x`), not the
 * system's progress: progress is spring-smoothed by the system and lags.
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
 * (`[data-back].mobile-*-exit` in globals.css) continue from exactly there.
 */

import type { BackEdge, BackGestureFrame, BackPreview } from './backHandler';

/** Settling back after a cancelled gesture. Same curve as `--spring-smooth`. */
const RELEASE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const RELEASE_MS = 360;
/** Commit tail for the screen underneath: matches the page's exit animation. */
const COMMIT_MS = 260;
const COMMIT_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
/** Peek commit: old content fades out this fast before the previous one slides in. */
const PEEK_SWAP_OUT_MS = 80;
/**
 * After a commit the layer gets this long to start its own exit animation. If it
 * has not (a "discard changes?" confirm, a handler that declined), the layer is
 * still on screen in a half-shrunk pose and must spring back.
 */
const COMMIT_GRACE_MS = 220;
/** Depth of the 3D effect: larger = flatter. Same value as in globals.css. */
const PERSPECTIVE_PX = 800;
/** Share of the card's half-size at which the press tilt is already at full strength. */
const PRESS_REACH = 0.65;
/** How far past the freed-up room the card may drift, px (see `cardPose`). */
const ROAM_SLACK_PX = 8;

/** `v` pulled smoothly toward ±`limit` (≈ linear when small, never beyond). */
function softLimit(v: number, limit: number): number {
  return limit > 0 ? limit * Math.tanh(v / limit) : 0;
}

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

function viewportHeight(): number {
  return window.innerHeight || 1;
}

/** Finger travel as a share of `span` viewport widths, eased (0 … 1). */
function travel(frame: BackGestureFrame, span: number): number {
  return ease(frame.dx / (viewportWidth() * span));
}

/** How strongly a layer reacts; every number is the value at a full-width swipe. */
interface CardFeel {
  /** Scale lost (0.3 → the card ends at 70%). Grows faster the further the finger goes. */
  shrink: number;
  /** Horizontal drift after the finger, as a share of the finger's travel. */
  drift: number;
  /** Vertical follow, as a share of the finger's vertical travel, and its limit (px). */
  follow: number;
  followMax: number;
  /** Peak press tilt, deg. */
  tilt: number;
}

const PAGE_FEEL: CardFeel = { shrink: 0.34, drift: 0.24, follow: 0.7, followMax: 160, tilt: 16 };
const PEEK_FEEL: CardFeel = { shrink: 0.18, drift: 0.16, follow: 0.35, followMax: 80, tilt: 10 };

/**
 * A card held by the finger. Shrink accelerates with travel (barely anything
 * for a short nudge, clearly "leaving" past the middle). The tilt is a press:
 * wherever the finger is relative to the card's centre, that part sinks away
 * from the viewer and the opposite part rises — so swiping from the right edge,
 * the right side first dips, and as the finger crosses to the left the card
 * rocks over to follow it.
 */
function cardPose(frame: BackGestureFrame, feel: CardFeel): Pose {
  const w = viewportWidth();
  const h = viewportHeight();
  const t = clamp(frame.dx / w, 0, 1);
  // Tilt and vertical follow come in quickly, so a small swipe already feels held.
  const grip = ease(frame.dx / (w * 0.4));
  const s = 1 - feel.shrink * Math.pow(t, 1.4);
  // Movement is limited by the room the shrink has freed (plus a little slack),
  // through a soft rubber band: the card roams further as it gets smaller but
  // never wanders off the screen.
  const x = softLimit(direction(frame.edge) * frame.dx * feel.drift, (w * (1 - s)) / 2 + ROAM_SLACK_PX);
  const y = softLimit(
    clamp(frame.dy * feel.follow, -feel.followMax, feel.followMax) * grip,
    (h * (1 - s)) / 2 + ROAM_SLACK_PX,
  );
  // Finger position relative to the card centre, -1 … 1; saturates well before
  // the card's edge so the tilt stays pronounced through most of the swipe.
  const fx = clamp((frame.x - (w / 2 + x)) / ((w * s) / 2) / PRESS_REACH, -1, 1);
  const fy = clamp((frame.y - (h / 2 + y)) / ((h * s) / 2) / PRESS_REACH, -1, 1);
  return {
    x,
    y,
    s,
    // rotateY(+) sinks the right side; rotateX(+) sinks the top.
    ry: fx * feel.tilt * grip,
    rx: -fy * feel.tilt * grip,
  };
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

  get element(): HTMLElement | null {
    return this.el;
  }

  begin(): void {
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
    const t = `${RELEASE_MS}ms ${RELEASE_EASING}`;
    el.style.transition = `transform ${t}, opacity ${t}`;
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

  /**
   * Commit for in-place navigation: the content under this element is being
   * swapped right now (by the layer's close), at a moment we cannot observe.
   * Fade the old content out where it is, then bring whatever is there by then
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
      this.set({ x: -dir * 32, y: 0, s: 0.96, rx: 0, ry: 0, o: 0 });
      // Commit the start pose before turning transitions back on.
      void el.offsetWidth;
      el.style.transition = `transform ${RELEASE_MS}ms ${RELEASE_EASING}, opacity 220ms ease-out`;
      this.set({ ...REST, o: 1 });
      this.timer = setTimeout(() => this.cleanup(), RELEASE_MS + 60);
    }, PEEK_SWAP_OUT_MS);
  }

  private cleanup(): void {
    this.clearTimer();
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
    for (const v of ['x', 'y', 's', 'rx', 'ry']) s.removeProperty(`--back-${v}`);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** The shell's content area: what a full-screen page covers. */
function shellContent(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-back-peek]');
}

/**
 * The screen a page lifts off from: pushed back and dimmed while covered, it
 * comes forward and brightens as the card shrinks away. One transform on the
 * underlying screen plus one scrim whose opacity moves; nothing else on screen
 * is touched.
 */
class Underlay {
  private el: HTMLElement | null = null;
  private scrim: HTMLDivElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

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
    this.set(0);
  }

  /**
   * `e` = eased reveal; 0 = page fully covering, 1 = finger all the way across.
   * Some dimming stays while the card is held so it keeps floating above the
   * screen behind (both are dark); it clears only once the page has gone.
   */
  set(e: number, gone = false): void {
    if (!this.el || !this.scrim) return;
    this.el.style.transform = `scale(${(0.92 + 0.08 * e).toFixed(4)})`;
    this.scrim.style.opacity = gone ? '0' : (0.22 + (1 - e) * 0.36).toFixed(3);
  }

  /** The page is leaving: the screen underneath settles at rest alongside it. */
  toRest(): void {
    this.animate(COMMIT_MS, COMMIT_EASING, 1, true);
  }

  /** The page came back: push the screen underneath back again. */
  toStart(): void {
    this.animate(RELEASE_MS, RELEASE_EASING, 0);
  }

  private animate(ms: number, easing: string, e: number, gone = false): void {
    if (!this.el || !this.scrim) return;
    this.clearTimer();
    const t = `${ms}ms ${easing}`;
    this.el.style.transition = `transform ${t}`;
    this.scrim.style.transition = `opacity ${t}`;
    this.set(e, gone);
    this.timer = setTimeout(() => this.cleanupNow(), ms + 60);
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

/**
 * Full-screen (or tab-stacked) sub-page: a floating card held by the finger;
 * shrinks away on commit. `getUnder` is the screen it covers — by default the
 * shell's content area, for a page stacked inside a tab the screen beneath it.
 */
export function pageBackPreview(
  getEl: () => HTMLElement | null,
  getUnder: () => HTMLElement | null = shellContent,
): BackPreview {
  const page = new Surface(getEl, 'page');
  const under = new Underlay();
  return {
    start() {
      page.begin();
      under.begin(getUnder(), page.element);
    },
    update(frame) {
      page.set(cardPose(frame, PAGE_FEEL));
      under.set(travel(frame, 0.7));
    },
    cancel() {
      page.release();
      under.toStart();
    },
    commit() {
      page.handOff(() => under.toStart());
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
  let height = 400;
  return {
    start() {
      sheet.begin();
      backdrop.begin();
      // One layout read per gesture: how far the sheet may sink.
      height = sheet.element?.getBoundingClientRect().height || height;
    },
    update(frame) {
      const e = travel(frame, 0.5);
      sheet.set({
        x: direction(frame.edge) * e * 14,
        y: e * Math.min(height * 0.2, 140),
        s: 1 - e * 0.08,
        // The top edge falls away from the viewer.
        rx: e * 6,
        ry: 0,
      });
      backdrop.set({ ...REST, o: 1 - e * 0.6 });
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
 * In-page navigation (no overlay to peel away): the content area recedes like
 * a gentler page card and dims. The target is any element marked
 * `data-back-peek` — currently the shell's `<main>` — so every layer of this
 * kind shares one pose and one rule. On commit the previous content slides in
 * from the other side.
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
      surface.set({ ...cardPose(frame, PEEK_FEEL), o: 1 - travel(frame, 0.6) * 0.35 });
    },
    cancel: () => surface.release(),
    commit: () => surface.swapIn(dir),
  };
}
