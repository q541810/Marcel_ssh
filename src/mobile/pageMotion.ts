/**
 * Page transitions and predictive back for pages (`MobileStackPage`,
 * `MobileFullscreenPage`): **leave the way you came** (§7).
 *
 * - **Open**: the page grows out of the control that opened it (the settings
 *   row, the button — see pageOrigin.ts): a card the shape of that row that
 *   expands to fill the screen while the screen behind it steps back.
 * - **Predictive back**: the page lifts off into a card held by the finger
 *   (`cardPose` in backPreview.ts — shrink, turn toward the swipe, pitch).
 * - **Release**: the card flies home — from exactly where it is, at exactly the
 *   speed it was moving (§5) — and lands on the row it came out of, taking that
 *   row's shape. Nothing fades away in mid-air: the card only dissolves in the
 *   last stretch, when it already sits on the row, the way an iOS zoom
 *   transition hands over to its source. The back button and any other close
 *   take the same flight.
 * - **Cancel**: the card springs back to full screen.
 *
 * With no origin (opened by a notification, a jump from elsewhere, or the row
 * has since scrolled away) the page comes in from the right edge and goes back
 * out the same way, the way an iOS navigation push does.
 *
 * Every motion is a spring (motion.ts), so each one can be interrupted at any
 * moment and the next one starts from the presented pose and speed: swipe back
 * while the page is still growing, reopen it while it is flying home — it
 * never jumps.
 *
 * ## How the card is drawn (cost)
 * The card is described in screen space — centre, width, height, corner
 * radius, two tilts — and drawn with a transform plus a `clip-path` that crops
 * the page to the card's shape (top-anchored, so a row-shaped card shows the
 * page's own header). While the finger holds the card the clip never changes,
 * so every frame is transform/opacity only (compositor). Only the flights
 * change the clip, i.e. repaint one layer for a few hundred ms.
 *
 * The card's shadow is a separate element behind it (transform/opacity only,
 * painted once): a clip-path would cut a box-shadow off, and this way the
 * shadow can dissolve as the card settles onto the surface, like a real one.
 * The dimming of the screen behind is a scrim whose opacity moves, not a filter.
 */

import { holdExitFallback } from '@/hooks/useAnimatedPresence';
import type { BackPreview } from './backHandler';
import { getBackFeel, type BackFeel } from './backFeel';
import {
  cardPose,
  PERSPECTIVE_PX,
  travel,
  viewportHeight,
  viewportWidth,
  type Pose,
} from './backPreview';
import {
  Blend,
  clamp,
  keyframes,
  prefersReducedMotion,
  Recorder,
  sampled,
  smoothstep,
  speedAt,
  springPath,
  zeroLike,
  type Channels,
  type Trajectory,
} from './motion';
import { claimOrigin } from './pageOrigin';

/** Corner radius of the lifted page, in the page's own (unscaled) px. */
const CARD_RADIUS = 28;
/** Share of the way, at the origin end, over which the shadow settles. */
const SHADOW_SPAN = 0.6;
/** After a commit, how long the page gets to start closing before the flight turns back. */
const COMMIT_GRACE_MS = 220;
/** Fallback (no origin): how far past the right edge the page parks, px. */
const OFFSCREEN_GAP_PX = 40;

/** The card in screen space (viewport px), plus its look. */
export interface Card extends Channels {
  /** centre */
  cx: number;
  cy: number;
  /** visible size */
  w: number;
  h: number;
  /** top / bottom corner radius in the page's own px (scaled with the card) */
  rt: number;
  rb: number;
  /** tilts, deg */
  rx: number;
  ry: number;
  /** opacity of the page */
  o: number;
  /** opacity of its shadow */
  sh: number;
  /**
   * The stand-in for the origin row that rides on the card, in two layers so
   * two sets of text are never seen at once: `src` is its plain surface (the
   * row's background) covering the page content, `txt` the row's content on
   * top of that surface. Landing: the surface comes first, then the text;
   * growing out of the row: the reverse.
   */
  src: number;
  txt: number;
}

/** What the card lands on: the origin's rect (screen behind at rest) and look. */
export interface Origin {
  el: Element;
  rect: { left: number; top: number; width: number; height: number };
  /** visible corner radii, px (taken from the clipping group for a row inside one) */
  radT: number;
  radB: number;
  /** the colour behind its content */
  bg: string;
}

/** The page's own box (viewport px), measured untransformed. */
export interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

/** The screen behind: its scale and the dimming over it. */
interface Under extends Channels {
  s: number;
  o: number;
}

/** Behind a page that covers it: pushed back and dimmed. */
const UNDER_COVERED: Under = { s: 0.9, o: 0.6 };
/** Uncovered: as it normally is. */
const UNDER_SHOWN: Under = { s: 1, o: 0 };

/** While the finger holds the card: the screen comes forward with travel. */
function underHeld(reveal: number): Under {
  // Some dimming stays while the card is held so it floats above the screen
  // behind (both are dark); it clears only as the page actually leaves.
  return { s: 0.9 + 0.1 * reveal, o: 0.24 + (1 - reveal) * 0.36 };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function restCard(b: Box): Card {
  return {
    cx: b.left + b.w / 2,
    cy: b.top + b.h / 2,
    w: b.w,
    h: b.h,
    rt: CARD_RADIUS,
    rb: CARD_RADIUS,
    rx: 0,
    ry: 0,
    o: 1,
    sh: 1,
    src: 0,
    txt: 0,
  };
}

/** The held pose (translate / scale / tilt of the whole page) as a card. */
function heldCard(p: Pose, b: Box): Card {
  const rest = restCard(b);
  return {
    ...rest,
    cx: rest.cx + p.x,
    cy: rest.cy + p.y,
    w: b.w * p.s,
    h: b.h * p.s,
    rx: p.rx,
    ry: p.ry,
  };
}

/**
 * Card that sits exactly on the origin, wearing it: the stand-in fully shown
 * (`src` 1), the page under it, the origin's own corner radii.
 */
function cardOn(origin: Pick<Origin, 'rect' | 'radT' | 'radB'>, b: Box): Card {
  const rect = origin.rect;
  // The crop keeps the page's full width and trims its bottom, so a card can
  // be relatively shorter than the page (a row) but not taller: a tall origin
  // gets a card as wide as it, centred on it.
  const w = rect.width;
  const h = Math.min(rect.height, (w * b.h) / b.w);
  const s = w / b.w;
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    w,
    h,
    rt: origin.radT / s,
    rb: origin.radB / s,
    rx: 0,
    ry: 0,
    o: 1,
    sh: 0,
    src: 1,
    txt: 1,
  };
}

/** Parked past the right edge at size `w` × `h` (the fallback "where it came from"). */
function offscreenCard(b: Box, w: number, h: number): Card {
  return {
    ...restCard(b),
    cx: b.left + b.w + w / 2 + OFFSCREEN_GAP_PX,
    w,
    h,
  };
}

function cardTransform(c: Card, b: Box): string {
  const s = Math.max(c.w / b.w, 1e-4);
  const hc = Math.min(b.h, c.h / s);
  // Origin at the page's top-left: move to the card centre, then project and
  // tilt around that centre, scale, and centre the cropped part on it.
  return (
    `translate3d(${(c.cx - b.left).toFixed(2)}px, ${(c.cy - b.top).toFixed(2)}px, 0) ` +
    `perspective(${PERSPECTIVE_PX}px) rotateX(${c.rx.toFixed(2)}deg) rotateY(${c.ry.toFixed(2)}deg) ` +
    `scale(${s.toFixed(5)}) translate(${(-b.w / 2).toFixed(2)}px, ${(-hc / 2).toFixed(2)}px)`
  );
}

function cardClip(c: Card, b: Box): string {
  const s = Math.max(c.w / b.w, 1e-4);
  const hc = Math.min(b.h, c.h / s);
  const rt = Math.max(0, c.rt).toFixed(1);
  const rb = Math.max(0, c.rb).toFixed(1);
  return `inset(0px 0px ${Math.max(0, b.h - hc).toFixed(1)}px 0px round ${rt}px ${rt}px ${rb}px ${rb}px)`;
}

function shadowTransform(c: Card, b: Box): string {
  return (
    `translate3d(${(c.cx - b.left).toFixed(2)}px, ${(c.cy - b.top).toFixed(2)}px, 0) ` +
    `perspective(${PERSPECTIVE_PX}px) rotateX(${c.rx.toFixed(2)}deg) rotateY(${c.ry.toFixed(2)}deg) ` +
    `scale(${(c.w / b.w).toFixed(5)}, ${(c.h / b.h).toFixed(5)}) ` +
    `translate(${(-b.w / 2).toFixed(2)}px, ${(-b.h / 2).toFixed(2)}px)`
  );
}

/**
 * The stand-in's box is the origin's own size; this maps it onto the card's
 * frame (same centre, tilt and size). Its content is then scaled back to
 * uniform (`standInnerTransform`) so the row's text is never squashed.
 */
function standTransform(c: Card, b: Box, sw: number, sh: number): string {
  return (
    `translate3d(${(c.cx - b.left).toFixed(2)}px, ${(c.cy - b.top).toFixed(2)}px, 0) ` +
    `perspective(${PERSPECTIVE_PX}px) rotateX(${c.rx.toFixed(2)}deg) rotateY(${c.ry.toFixed(2)}deg) ` +
    `scale(${(c.w / sw).toFixed(5)}, ${(c.h / sh).toFixed(5)}) ` +
    `translate(${(-sw / 2).toFixed(2)}px, ${(-sh / 2).toFixed(2)}px)`
  );
}

function standInnerTransform(c: Card, sw: number, sh: number): string {
  const sx = c.w / sw;
  const sy = Math.max(c.h / sh, 1e-4);
  return `scale(1, ${(sx / sy).toFixed(5)})`;
}

/** Sum of the distances of the four edges, px. */
function rectGap(a: Card, b: Card): number {
  return (
    Math.abs(a.cx - a.w / 2 - (b.cx - b.w / 2)) +
    Math.abs(a.cx + a.w / 2 - (b.cx + b.w / 2)) +
    Math.abs(a.cy - a.h / 2 - (b.cy - b.h / 2)) +
    Math.abs(a.cy + a.h / 2 - (b.cy + b.h / 2))
  );
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

/**
 * How the look changes along a flight. The page itself never turns
 * see-through, and the page's content and the row's content are never shown
 * over each other:
 * - `home`: landing on the origin — in the first half of the last
 *   {@link handOver} px the row's plain surface covers the page content, in
 *   the second half the row's text appears on it; by touchdown the card *is*
 *   the row. The shadow settles over the last {@link SHADOW_SPAN} of the way.
 * - `grow`: leaving the origin — the mirror image.
 * - `plain`: no hand-over (cancel, the off-screen fallback).
 */
type Look = 'home' | 'grow' | 'plain';

/** Distance (sum of edge gaps, px) from the origin over which the row and page swap on the card. */
function handOver(origin: Card): number {
  return clamp(1.5 * Math.min(origin.w, origin.h), 24, 120);
}

/** 1 at the origin, 0 once `gap` is past the hand-over: [surface, text]. */
function swapAt(gap: number, origin: Card): [number, number] {
  const g = gap / handOver(origin);
  return [1 - smoothstep((g - 0.5) / 0.5), 1 - smoothstep(g / 0.5)];
}

function lookAt(
  look: Look,
  from: Card,
  to: Card,
  c: Card,
  left: number,
): { o: number; sh: number; src: number; txt: number } {
  if (look === 'home') {
    const [surface, text] = swapAt(rectGap(c, to), to);
    return {
      o: from.o,
      sh: from.sh * smoothstep(left / SHADOW_SPAN),
      src: Math.max(from.src, surface),
      txt: Math.max(from.txt, text),
    };
  }
  if (look === 'grow') {
    const [surface, text] = swapAt(rectGap(c, from), from);
    return {
      o: from.o,
      sh: from.sh + (1 - from.sh) * smoothstep((1 - left) / SHADOW_SPAN),
      src: Math.min(from.src, surface),
      txt: Math.min(from.txt, text),
    };
  }
  const mix = (k: 'o' | 'sh' | 'src' | 'txt') => to[k] + (from[k] - to[k]) * left;
  return { o: mix('o'), sh: mix('sh'), src: mix('src'), txt: mix('txt') };
}

const CARD_TOLERANCE = (k: string): number =>
  k === 'rx' || k === 'ry' ? 0.1 : k === 'o' || k === 'sh' || k === 'src' || k === 'txt' ? 0.01 : 0.4;

/**
 * A spring flight from `from` (moving at `v` per ms) to `to`: geometry and
 * tilt are independent springs (tilts may overshoot a hair, the rest never);
 * the look follows the geometry ({@link lookAt}), so the hand-over happens
 * where the card is, not at some point in time.
 */
function flight(
  from: Card,
  v: Card,
  to: Card,
  look: Look,
  response: number,
): { path: Trajectory<Card>; ms: number } {
  const run = springPath(from, { ...v, o: 0, sh: 0, src: 0, txt: 0 }, to, {
    response,
    damping: { rx: 0.85, ry: 0.85 },
    tolerance: CARD_TOLERANCE,
  });
  const total = rectGap(from, to);
  const n = run.samples.length;
  const samples = run.samples.map((c, i) => {
    const left = total > 1 ? clamp(rectGap(c, to) / total, 0, 1) : 1 - i / Math.max(1, n - 1);
    if (i < n - 1) return { ...c, ...lookAt(look, from, to, c, left) };
    // Touchdown on the row: the stand-in is the row now; the page underneath
    // is let go of (it unmounts) and the stand-in is removed onto the real row.
    return look === 'home' ? { ...to, o: 0 } : { ...to };
  });
  return { path: sampled(samples, run.dt), ms: run.ms };
}

// ---------------------------------------------------------------------------
// The page element
// ---------------------------------------------------------------------------

/**
 * A copy of the origin row, worn by the card while it lands on (or grows out
 * of) that row. Visual only: inert, hidden from assistive tech, no ids.
 */
function makeStandIn(origin: Origin): { outer: HTMLDivElement; inner: HTMLDivElement } {
  const { width: sw, height: sh } = origin.rect;
  const outer = document.createElement('div');
  outer.dataset.backStandIn = '';
  outer.setAttribute('aria-hidden', 'true');
  outer.inert = true;
  outer.style.cssText =
    `width:${sw}px;height:${sh}px;pointer-events:none;transform-origin:0 0;overflow:hidden;` +
    `will-change:transform,opacity;opacity:0;background:${origin.bg};` +
    `border-radius:${origin.radT}px ${origin.radT}px ${origin.radB}px ${origin.radB}px;`;
  const inner = document.createElement('div');
  inner.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%;will-change:transform;';
  const copy = origin.el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  // Selectors like `:not(:first-child)` won't match the copy where it sits
  // now: carry over the box styles that make it look the way it does.
  const cs = getComputedStyle(origin.el);
  const keep = [
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'background-color',
    'color',
    'font-family',
    'font-size',
    'line-height',
    'padding',
    'box-sizing',
  ];
  for (const k of keep) copy.style.setProperty(k, cs.getPropertyValue(k));
  copy.style.setProperty('width', '100%');
  copy.style.setProperty('height', '100%');
  copy.style.setProperty('margin', '0');
  copy.style.setProperty('border-radius', '0');
  inner.appendChild(copy);
  outer.appendChild(inner);
  return { outer, inner };
}

const SHADOW_CSS =
  'pointer-events:none;transform-origin:0 0;will-change:transform,opacity;opacity:0;' +
  `border-radius:${CARD_RADIUS}px;` +
  'box-shadow:0 0 0 1px rgb(128 128 128 / 0.22),0 18px 48px rgb(0 0 0 / 0.42);';

/**
 * Owns the page element while it is a card (gesture or flight) and restores it
 * afterwards. Never touches `className` (React owns it) — only `data-back`,
 * inline style, Web Animations it starts, and its own shadow element.
 */
class PageCard {
  el: HTMLElement | null = null;
  box: Box = { left: 0, top: 0, w: 1, h: 1 };
  private shadow: HTMLDivElement | null = null;
  private stand: { outer: HTMLDivElement; inner: HTMLDivElement; w: number; h: number } | null = null;
  private last: Card | null = null;
  private clip = '';
  private anims: Animation[] = [];
  private playing: { path: Trajectory<Card>; ms: number; started: number } | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rec = new Recorder<Card>();
  private readonly blend = new Blend<Card>();

  constructor(private readonly resolve: () => HTMLElement | null) {}

  get rest(): Card {
    return restCard(this.box);
  }

  get isPlaying(): boolean {
    return this.playing != null;
  }

  /** Take over the page element (no-op if already ours). False if there is none. */
  attach(): boolean {
    const el = this.resolve();
    if (!el) return false;
    if (this.el === el && el.isConnected) return true;
    this.cleanup();
    this.el = el;
    // Switches the exit class to the timing-only hold (globals.css).
    el.dataset.back = 'page';
    // The CSS entrance fills `forwards` and would outrank our inline pose;
    // cancelling a CSS animation sticks until its name changes.
    for (const a of el.getAnimations?.() ?? []) {
      const name = (a as CSSAnimation).animationName ?? '';
      if (/Enter$/.test(name) || name === 'mobileFullscreenExit') a.cancel();
    }
    const r = el.getBoundingClientRect();
    this.box = { left: r.left, top: r.top, w: r.width || 1, h: r.height || 1 };
    const s = el.style;
    s.transition = 'none';
    s.willChange = 'transform, opacity';
    s.transformOrigin = '0 0';
    this.clip = '';
    this.rec.reset();
    this.blend.clear();
    const parent = el.parentElement;
    if (parent) {
      const cs = getComputedStyle(el);
      const shadow = document.createElement('div');
      shadow.dataset.backShadow = '';
      shadow.setAttribute('aria-hidden', 'true');
      shadow.style.cssText =
        `position:${cs.position === 'fixed' ? 'fixed' : 'absolute'};` +
        `left:${el.offsetLeft}px;top:${el.offsetTop}px;width:${el.offsetWidth}px;height:${el.offsetHeight}px;` +
        `z-index:${cs.zIndex};${SHADOW_CSS}`;
      parent.insertBefore(shadow, el);
      this.shadow = shadow;
    }
    return true;
  }

  /** Dress the card with a stand-in for `origin` (replacing any), or take it off. */
  wear(origin: Origin | null): void {
    this.dropStandIn();
    const el = this.el;
    if (!origin || !el?.parentElement) return;
    const { outer, inner } = makeStandIn(origin);
    const cs = getComputedStyle(el);
    outer.style.position = cs.position === 'fixed' ? 'fixed' : 'absolute';
    outer.style.left = `${el.offsetLeft}px`;
    outer.style.top = `${el.offsetTop}px`;
    outer.style.zIndex = cs.zIndex;
    // Right above the card, in its stacking context.
    el.parentElement.insertBefore(outer, el.nextSibling);
    this.stand = { outer, inner, w: origin.rect.width, h: origin.rect.height };
    if (this.last) this.write(this.last);
  }

  dropStandIn(): void {
    const st = this.stand;
    if (!st) return;
    st.outer.getAnimations?.().forEach((a) => a.cancel());
    st.inner.getAnimations?.().forEach((a) => a.cancel());
    st.outer.remove();
    this.stand = null;
  }

  /** The element directly below the card in paint order that the scrim must go under. */
  get lowest(): HTMLElement | null {
    return this.shadow ?? this.el;
  }

  /** Presented card and its speed (per ms) — mid-animation if one is playing. */
  now(): [Card, Card] {
    const p = this.playing;
    if (p) {
      const t = clamp(performance.now() - p.started, 0, p.ms);
      return [p.path(t), speedAt(p.path, t)];
    }
    const last = this.last ?? this.rest;
    return [last, this.rec.velocity(last)];
  }

  /** The finger takes over: stop any flight, blending from where it was shown. */
  hold(first: Card): void {
    const shown = this.playing ? this.now()[0] : null;
    this.stop();
    this.rec.reset();
    this.blend.from(shown, first);
    // Stopping the flight uncovers the inline pose (its end): keep showing where
    // the card was until the finger's first frame arrives.
    if (shown) {
      this.last = shown;
      this.write(shown);
    }
  }

  set(c: Card): void {
    const shown = this.blend.apply(c);
    this.last = shown;
    this.rec.push(shown);
    this.write(shown);
  }

  play(path: Trajectory<Card>, ms: number, onDone?: () => void): void {
    const el = this.el;
    if (!el) return;
    this.stop();
    const b = this.box;
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
      keyframes(path, ms, (c) => ({
        transform: cardTransform(c, b),
        clipPath: cardClip(c, b),
        opacity: c.o,
      })),
      { duration: ms, fill: 'forwards' },
    );
    this.anims = [anim];
    if (this.shadow) {
      this.anims.push(
        this.shadow.animate(
          keyframes(path, ms, (c) => ({ transform: shadowTransform(c, b), opacity: c.sh * c.o })),
          { duration: ms, fill: 'forwards' },
        ),
      );
    }
    const st = this.stand;
    if (st) {
      this.anims.push(
        st.outer.animate(
          keyframes(path, ms, (c) => ({ transform: standTransform(c, b, st.w, st.h), opacity: c.src })),
          { duration: ms, fill: 'forwards' },
        ),
        st.inner.animate(
          keyframes(path, ms, (c) => ({ transform: standInnerTransform(c, st.w, st.h), opacity: c.txt })),
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

  /** Remove the shadow element only (the card itself stays as it is). */
  dropShadow(): void {
    this.shadow?.getAnimations?.().forEach((a) => a.cancel());
    this.shadow?.remove();
    this.shadow = null;
  }

  cleanup(): void {
    this.stop();
    this.dropShadow();
    this.dropStandIn();
    const el = this.el;
    this.el = null;
    this.last = null;
    this.clip = '';
    this.blend.clear();
    if (!el) return;
    delete el.dataset.back;
    const s = el.style;
    s.transition = '';
    s.willChange = '';
    s.transformOrigin = '';
    s.transform = '';
    s.clipPath = '';
    s.opacity = '';
    s.pointerEvents = '';
    s.removeProperty('--back-ms');
  }

  private write(c: Card): void {
    const el = this.el;
    if (!el) return;
    const b = this.box;
    el.style.transform = cardTransform(c, b);
    el.style.opacity = c.o.toFixed(3);
    const clip = cardClip(c, b);
    // Unchanged while held: no repaint, compositor only.
    if (clip !== this.clip) {
      this.clip = clip;
      el.style.clipPath = clip;
    }
    if (this.shadow) {
      this.shadow.style.transform = shadowTransform(c, b);
      this.shadow.style.opacity = (c.sh * c.o).toFixed(3);
    }
    const st = this.stand;
    if (st) {
      st.outer.style.transform = standTransform(c, b, st.w, st.h);
      st.outer.style.opacity = c.src.toFixed(3);
      st.inner.style.transform = standInnerTransform(c, st.w, st.h);
      st.inner.style.opacity = c.txt.toFixed(3);
    }
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
// The screen behind
// ---------------------------------------------------------------------------

/** The shell's content area: what a full-screen page covers. */
function shellContent(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-back-peek]');
}

/**
 * Pushed back and dimmed while covered, it comes forward and brightens as the
 * page leaves. One transform on the screen behind plus one scrim whose opacity
 * moves; nothing else on screen is touched.
 */
class Underlay {
  el: HTMLElement | null = null;
  private scrim: HTMLDivElement | null = null;
  private anims: Animation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: Under = UNDER_SHOWN;
  private playing: { path: Trajectory<Under>; ms: number; started: number } | null = null;
  private readonly rec = new Recorder<Under>();
  private readonly blend = new Blend<Under>();

  /**
   * Take over `under` at pose `start` — or, if it is already ours (an animation
   * still running), keep it where it is shown. The scrim goes right below the
   * card (and its shadow), in the card's own stacking context, so it dims
   * everything under the card and only that.
   */
  begin(under: HTMLElement | null, card: HTMLElement | null, lowest: HTMLElement | null, start: Under): void {
    if (under && under === this.el && this.scrim?.isConnected) {
      const shown = this.now()[0];
      this.stop();
      this.apply(shown);
      return;
    }
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
    const before = lowest && lowest.parentElement === card.parentElement ? lowest : card;
    card.parentElement.insertBefore(scrim, before);
    this.scrim = scrim;
    this.rec.reset();
    this.blend.clear();
    this.apply(start);
  }

  /** The finger takes over: blend from where it was shown. */
  hold(first: Under): void {
    const shown = this.playing ? this.now()[0] : null;
    this.stop();
    this.rec.reset();
    this.blend.from(shown, first);
    if (shown) this.apply(shown);
  }

  set(p: Under): void {
    const shown = this.blend.apply(p);
    this.rec.push(shown);
    this.apply(shown);
  }

  /** Spring to `to` from the presented pose and speed; `onDone` once settled. */
  to(to: Under, response: number, onDone?: () => void): void {
    const [from, v] = this.now();
    const run = springPath(from, v, to, {
      response,
      tolerance: (k) => (k === 's' ? 0.0005 : 0.002),
    });
    this.play(run.path, run.ms, onDone);
  }

  /**
   * Where `rect` (of an element inside this screen, as measured now) will be
   * once the screen is back at its normal scale.
   */
  unscale(el: Element, rect: DOMRect): { left: number; top: number; width: number; height: number } {
    const under = this.el;
    const s = this.now()[0].s;
    if (!under || !under.contains(el) || Math.abs(s - 1) < 1e-4) return rect;
    const u = under.getBoundingClientRect();
    const cx = u.left + u.width / 2;
    const cy = u.top + u.height / 2;
    return {
      left: cx + (rect.left - cx) / s,
      top: cy + (rect.top - cy) / s,
      width: rect.width / s,
      height: rect.height / s,
    };
  }

  now(): [Under, Under] {
    const p = this.playing;
    if (!p) return [this.last, this.rec.velocity(this.last)];
    const t = clamp(performance.now() - p.started, 0, p.ms);
    return [p.path(t), speedAt(p.path, t)];
  }

  private apply(p: Under): void {
    if (!this.el || !this.scrim) return;
    this.last = p;
    this.el.style.transform = `scale(${p.s.toFixed(4)})`;
    this.scrim.style.opacity = p.o.toFixed(3);
  }

  private play(path: Trajectory<Under>, ms: number, onDone?: () => void): void {
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
    this.timer = setTimeout(() => {
      this.timer = null;
      onDone?.();
    }, ms + 20);
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

  cleanupNow(): void {
    this.stop();
    const el = this.el;
    this.el = null;
    this.last = UNDER_SHOWN;
    this.blend.clear();
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
// The origin's look
// ---------------------------------------------------------------------------

function px(v: string): number {
  return parseFloat(v) || 0;
}

/**
 * Visible top / bottom corner radii of `el` (layout px). A row inside a
 * rounded group has square corners of its own but is clipped round by the
 * group where it touches the group's corners — that is what shows, so that
 * is what the card must land with.
 */
function cornerRadii(el: Element, rect: DOMRect): { radT: number; radB: number } {
  const cs = getComputedStyle(el);
  let radT = px(cs.borderTopLeftRadius);
  let radB = px(cs.borderBottomLeftRadius);
  let p = el.parentElement;
  for (let i = 0; i < 4 && p && (!radT || !radB); i++, p = p.parentElement) {
    const pcs = getComputedStyle(p);
    if (pcs.overflow === 'visible' && pcs.overflowX === 'visible') continue;
    const pr = p.getBoundingClientRect();
    const tol = 1.5;
    const sameLeft = Math.abs(pr.left - rect.left) < tol;
    if (!radT && sameLeft && Math.abs(pr.top - rect.top) < tol) radT = px(pcs.borderTopLeftRadius);
    if (!radB && sameLeft && Math.abs(pr.bottom - rect.bottom) < tol) radB = px(pcs.borderBottomLeftRadius);
  }
  return { radT, radB };
}

/** Alpha of a computed colour in any notation (`rgba(…)`, `oklch(… / a)`, `transparent`). */
function alphaOf(color: string): number {
  if (!color || color === 'transparent') return 0;
  const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)/);
  if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = color.match(/^rgba\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(',');
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  }
  return 1;
}

/** The first solid background behind `el`'s content (its own or an ancestor's). */
function backdropOf(el: Element): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (alphaOf(bg) > 0.5) return bg;
  }
  return getComputedStyle(document.body).backgroundColor || '#000';
}

// ---------------------------------------------------------------------------
// The page motion (one per page component)
// ---------------------------------------------------------------------------

export interface PageMotion {
  /** Register this with the page's back handler. */
  preview: BackPreview;
  /** The page has just opened (its element is in the DOM): grow out of the origin. */
  enter(): void;
  /** The page is closing (its exit class is applied): fly home, unless a gesture already does. */
  exit(): void;
  /** The page element is gone: drop everything left behind (scrim, shadow, styles). */
  dispose(): void;
}

/**
 * One page's transitions. `getUnder` is the screen it covers — by default the
 * shell's content area; for a page stacked inside a tab, the screen beneath it.
 */
export function createPageMotion(
  getEl: () => HTMLElement | null,
  getUnder: () => HTMLElement | null = shellContent,
): PageMotion {
  const card = new PageCard(getEl);
  const under = new Underlay();
  let feel: BackFeel = getBackFeel();
  let origin: Element | null = null;
  /** A flight home is under way (gesture commit or close). */
  let flyingHome = false;
  /** The page's own close has started this open cycle. */
  let closing = false;
  let grace: ReturnType<typeof setTimeout> | null = null;

  const clearGrace = () => {
    if (grace != null) clearTimeout(grace);
    grace = null;
  };

  /** Where the origin is (as it will be once the screen behind is back at rest), and its look. */
  function measureOrigin(): Origin | null {
    const o = origin;
    const el = card.el;
    if (!o || !o.isConnected || (el && el.contains(o))) return null;
    const measured = o.getBoundingClientRect();
    if (measured.width < 4 || measured.height < 4) return null;
    const r = under.unscale(o, measured);
    // Scrolled out of sight (or hidden away): nowhere to land.
    if (r.top + r.height < 0 || r.top > viewportHeight() || r.left + r.width < 0 || r.left > viewportWidth()) {
      return null;
    }
    const { radT, radB } = cornerRadii(o, measured);
    return {
      el: o,
      rect: r,
      radT: Math.min(radT, r.height / 2),
      radB: Math.min(radB, r.height / 2),
      bg: backdropOf(o),
    };
  }

  function holdFrame(p: Pose): Card {
    return heldCard(p, card.box);
  }

  /** Release / close: fly from where the card is shown into the origin (or out right). */
  function flyHome(): void {
    const el = card.el;
    if (!el) return;
    flyingHome = true;
    // On its way out: taps go to the screen it is landing on, not to it.
    el.style.pointerEvents = 'none';
    const [from, v] = card.now();
    under.begin(getUnder(), el, card.lowest, UNDER_COVERED);
    const landing = measureOrigin();
    card.wear(landing);
    const home = landing ? cardOn(landing, card.box) : null;
    const to = home ?? offscreenCard(card.box, from.w, from.h);
    const { path, ms } = flight(from, v, to, home ? 'home' : 'plain', feel.flight);
    // The exit class only times the unmount: make it wait for the flight.
    el.style.setProperty('--back-ms', `${Math.round(ms)}ms`);
    // Only a flight that actually plays may hold up the unmount.
    if (typeof el.animate === 'function') holdExitFallback(ms + 80);
    card.play(path, ms, () => {
      // Landed (invisible on the row, or parked off-screen). The page unmounts
      // now; until it does, leave it where it landed, but take away what lives
      // outside it.
      card.dropShadow();
      card.dropStandIn();
      under.cleanupNow();
      if (!el.isConnected) card.cleanup();
    });
    under.to(UNDER_SHOWN, feel.flight);
  }

  /** Back to full screen from wherever the card is shown. */
  function settleBack(): void {
    flyingHome = false;
    if (card.el) card.el.style.pointerEvents = '';
    const [from, v] = card.now();
    const { path, ms } = flight(from, v, card.rest, 'plain', feel.flight);
    card.play(path, ms, () => card.cleanup());
    under.to(UNDER_COVERED, feel.flight, () => under.cleanupNow());
  }

  const preview: BackPreview = {
    start() {
      clearGrace();
      feel = getBackFeel();
      if (!card.attach()) return;
      flyingHome = false;
      const el = card.el;
      under.begin(getUnder(), el, card.lowest, UNDER_COVERED);
      const restPose: Pose = { x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1 };
      card.hold(holdFrame(restPose));
      under.hold(underHeld(0));
    },
    update(frame) {
      if (!card.el) return;
      card.set(holdFrame(cardPose(frame, feel, 1)));
      under.set(underHeld(travel(frame, 0.7)));
    },
    cancel() {
      if (!card.el) return;
      settleBack();
    },
    commit() {
      if (!card.el) return;
      flyHome();
      // The page is about to close (exit() marks it). If it doesn't — a
      // "discard changes?" confirm, a handler that declined — turn back.
      clearGrace();
      grace = setTimeout(() => {
        grace = null;
        const el = card.el;
        if (!el || !el.isConnected) return card.cleanup();
        if (closing) return;
        settleBack();
      }, COMMIT_GRACE_MS);
    },
  };

  return {
    preview,
    enter() {
      closing = false;
      clearGrace();
      if (prefersReducedMotion()) return;
      const el0 = getEl();
      // Reopened mid-flight: same element, same origin, turn around from where it is.
      const wasOurs = el0 != null && card.el === el0 && card.isPlaying;
      origin = claimOrigin(el0) ?? (wasOurs ? origin : null);
      feel = getBackFeel();
      if (!card.attach()) return;
      const el = card.el;
      flyingHome = false;
      if (el) el.style.pointerEvents = '';
      // Start on the origin (or parked off the right edge) — or, reopened
      // mid-flight, from wherever it is shown.
      let from: Card;
      let v: Card;
      if (wasOurs) {
        [from, v] = card.now();
      } else {
        const start = measureOrigin();
        card.wear(start);
        from = start ? cardOn(start, card.box) : offscreenCard(card.box, card.box.w, card.box.h);
        v = zeroLike(from);
      }
      // Out of the row: the card starts as the row and the page shows through as it leaves.
      const look: Look = from.src > 0 ? 'grow' : 'plain';
      under.begin(getUnder(), el, card.lowest, UNDER_SHOWN);
      const { path, ms } = flight(from, v, card.rest, look, feel.flight);
      card.play(path, ms, () => card.cleanup());
      under.to(UNDER_COVERED, feel.flight, () => under.cleanupNow());
    },
    exit() {
      if (closing) return;
      closing = true;
      clearGrace();
      if (flyingHome || prefersReducedMotion()) return;
      feel = getBackFeel();
      if (!card.attach()) return;
      flyHome();
    },
    dispose() {
      clearGrace();
      flyingHome = false;
      closing = false;
      card.cleanup();
      under.cleanupNow();
    },
  };
}

/** Pure pieces, exported for unit tests only. */
export const __pageMotionMath = {
  restCard,
  heldCard,
  cardOn,
  offscreenCard,
  cardTransform,
  cardClip,
  flight,
  UNDER_COVERED,
};
