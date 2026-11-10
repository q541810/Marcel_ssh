/**
 * Page transitions and predictive back for pages (`MobileStackPage`,
 * `MobileFullscreenPage`): **leave the way you came** (§7).
 *
 * One object the whole way — the page as a card — that only ever moves, turns,
 * scales and (at the very end, already tiny and sitting on its origin) melts
 * away. Nothing is cropped, recoloured or swapped mid-air.
 *
 * - **Open**: the page grows out of the control that opened it (the settings
 *   row, the button — see pageOrigin.ts) while the screen behind steps back.
 * - **Predictive back**: the page lifts off into a card held by the finger
 *   (`cardPose` in backPreview.ts — shrink, turn toward the swipe, pitch). The
 *   tilt trails a quick finger with a little weight (`feel.sway`); size and
 *   position follow at once. The origin lights up faintly: that is where the
 *   card will go.
 * - **Release**: the card flies home from exactly where it is, keeps shrinking,
 *   and dives into its origin — carrying on at the speed it had, pushed along by
 *   the finger's own speed (a flick flies faster than a gentle let-go). The
 *   origin catches it: it dips and glows as the card arrives. The back button
 *   and any other close take the same flight.
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
 * ## Cost: the compositor plays it
 * A flight animates `transform` and `opacity` only — on the card, on its shadow
 * (a separate element: the card's rounded clip would cut a box-shadow off), on
 * the screen behind and on the scrim over it. Those are the properties the
 * compositor animates by itself, so a flight keeps its frame rate while React
 * is busy mounting or closing the page. The card's rounded clip is set once and
 * never changes. **Do not add a property that needs a repaint (clip-path,
 * border-radius, colours, sizes) to a flight's keyframes**: one such property
 * moves the whole animation to the main thread, and it stutters or skips
 * exactly when the page is loading — the old row-shaped landing did that.
 *
 * Nothing heavy happens at release either: the origin is measured when the
 * gesture starts, and `backHandler` closes the layer a frame after the flight
 * has been handed over. An opening page gets its first paint through before it
 * starts to grow, so a slow first frame cannot eat the start of the motion.
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
  absorbable,
  afterFrame,
  Blend,
  clamp,
  keyframes,
  prefersReducedMotion,
  Recorder,
  sampled,
  smoothstep,
  speedAt,
  springPath,
  springStep,
  zeroLike,
  type Channels,
  type Trajectory,
} from './motion';
import { claimOrigin } from './pageOrigin';

/** Corner radius of the lifted page, in the page's own (unscaled) px. */
const CARD_RADIUS = 28;
/** After a commit, how long the page gets to start closing before the flight turns back. */
const COMMIT_GRACE_MS = 220;
/** Fallback (no origin): how far past the right edge the page parks, px. */
const OFFSCREEN_GAP_PX = 96;
/** …and how far past it the card (shadow included) is out of sight: the flight out ends there. */
const OFFSCREEN_CLEAR_PX = 52;
/** The card never lands smaller than this share of the page (a dot would just vanish). */
const MIN_CHIP_SCALE = 0.04;
/**
 * Where, on the way between full screen and the origin (0 = on the origin,
 * 1 = full screen), the card is solid / gone. It melts only over the last
 * stretch, when it is already small and sitting on the origin.
 */
const FADE_START = 0.16;
const FADE_END = 0.03;
/** How far past the origin the flight home aims, as a share of the way (it ends on the origin). */
const HOME_REACH = 0.12;
/** Share of the way, at the origin end, over which the shadow settles. */
const SHADOW_SPAN = 0.6;
/** How much of the finger's speed the released card is thrown with. */
const THROW_GAIN = 0.5;
/** Finger speed (px/ms) counted as a full-strength flick; anything faster is capped. */
const FAST_THROW = 2;
/** A full-strength flick shortens the flight home by this share. */
const THROW_HURRY = 0.3;

/** The card: where the page's centre is (from its resting place), its size and tilt, its look. */
export interface Card extends Channels {
  /** centre offset from rest, px */
  x: number;
  y: number;
  /** uniform scale */
  s: number;
  /** tilts, deg */
  rx: number;
  ry: number;
  /** opacity of the page */
  o: number;
  /** opacity of its shadow */
  sh: number;
}

/** The page's own box (viewport px), measured untransformed. */
export interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the card lands: the origin element and its rect once the screen behind is at rest. */
interface Landing {
  el: Element;
  rect: Rect;
}

const REST: Card = { x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1, sh: 1 };

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

/** The held pose (translate / scale / tilt of the whole page) as a card. */
function heldCard(p: Pose): Card {
  return { x: p.x, y: p.y, s: p.s, rx: p.rx, ry: p.ry, o: 1, sh: 1 };
}

/**
 * The card as it lands: the whole page, shrunk until it fits inside the origin
 * and centred on it — gone by then (`o` 0), the origin showing in its place.
 */
function chipOn(rect: Rect, b: Box): Card {
  const s = clamp(Math.min(rect.width / b.w, rect.height / b.h), MIN_CHIP_SCALE, 1);
  return {
    x: rect.left + rect.width / 2 - (b.left + b.w / 2),
    y: rect.top + rect.height / 2 - (b.top + b.h / 2),
    s,
    rx: 0,
    ry: 0,
    o: 0,
    sh: 0,
  };
}

/** Parked past the right edge at scale `s` (the fallback "where it came from"). */
function offscreenCard(b: Box, s: number): Card {
  return { ...REST, x: b.w / 2 + (b.w * s) / 2 + OFFSCREEN_GAP_PX, s };
}

function cardTransform(c: Card): string {
  // Origin at the page's centre: move there, then project and tilt around it.
  return (
    `translate3d(${c.x.toFixed(2)}px, ${c.y.toFixed(2)}px, 0) ` +
    `perspective(${PERSPECTIVE_PX}px) rotateX(${c.rx.toFixed(2)}deg) rotateY(${c.ry.toFixed(2)}deg) ` +
    `scale(${Math.max(c.s, 1e-4).toFixed(5)})`
  );
}

/** How far apart two cards are, px: centre distance plus the size difference at the page's scale. */
function gap(a: Card, b: Card, box: Box): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + (Math.abs(a.s - b.s) * (box.w + box.h)) / 2;
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

/**
 * How the look changes along a flight — by where the card is, not by the clock,
 * so an interrupted flight picks its look up where it left it:
 * - `home`: into the origin (`chip`) — solid until the last stretch, then it
 *   melts into the origin; the shadow settles on the way. Ends as soon as the
 *   card is gone, without waiting out the spring's tail.
 * - `grow`: out of the origin — the mirror image.
 * - `leave`: out past the right edge; ends once the card is off screen.
 * - `plain`: nothing special (cancel, coming in from the right).
 */
type Look = 'home' | 'grow' | 'leave' | 'plain';

const CARD_TOLERANCE = (k: string): number =>
  k === 'rx' || k === 'ry' ? 0.1 : k === 's' ? 0.0008 : k === 'o' || k === 'sh' ? 10 : 0.4;

/** Solid beyond `solidAt` (share of the way from the origin), gone within {@link FADE_END}. */
function solidity(near: number, solidAt: number): number {
  return solidAt > FADE_END ? smoothstep((near - FADE_END) / (solidAt - FADE_END)) : 0;
}

/**
 * A spring flight from `from` (moving at `v` per ms) to `to`: position, size
 * and tilt are independent springs (tilts may overshoot a hair, the rest
 * never). `chip` is the card on the origin, for the looks that need it.
 */
function flight(
  from: Card,
  v: Card,
  to: Card,
  look: Look,
  response: number,
  box: Box,
  chip: Card | null = null,
): { path: Trajectory<Card>; ms: number } {
  const diving = look === 'home' && chip != null;
  // Into the origin, the spring aims a little past it and the flight ends on
  // it: the card arrives still moving and dives in, instead of slowing to a
  // crawl just above the origin and hanging there half faded.
  const reach = diving ? 1 + HOME_REACH : 1;
  const aim: Card = diving
    ? {
        ...to,
        x: from.x + (to.x - from.x) * reach,
        y: from.y + (to.y - from.y) * reach,
        s: from.s + (to.s - from.s) * reach,
      }
    : to;
  const run = springPath(from, { ...v, o: 0, sh: 0 }, aim, {
    response,
    damping: { rx: 0.85, ry: 0.85 },
    tolerance: CARD_TOLERANCE,
  });
  const body = run.samples.slice(0, -1);
  const out: Card[] = [];
  if (chip && (look === 'home' || look === 'grow')) {
    const whole = Math.max(1, gap(REST, chip, box));
    const near = (c: Card) => gap(c, chip, box) / whole;
    if (look === 'home') {
      const start = near(from);
      // A flight that starts inside the fade or shadow range keeps what it had.
      const solidAt = Math.min(FADE_START, start);
      const shadowAt = Math.min(SHADOW_SPAN, Math.max(start, 1e-3));
      const omega = (2 * Math.PI) / (response * 1000);
      for (let i = 0; i < body.length; i++) {
        // How much of the way to the origin is covered (1 = on it).
        const wt = omega * i * run.dt;
        const covered = reach * (1 - (1 + wt) * Math.exp(-wt));
        const r = near(body[i]);
        if (i > 0 && (covered >= 1 || r <= FADE_END)) break;
        out.push({
          ...body[i],
          // By where it is; and gone by the time it is there, whatever a throw did to its path.
          o: from.o * Math.min(solidity(r, solidAt), smoothstep((1 - covered) / 0.1)),
          sh: from.sh * smoothstep(r / shadowAt),
        });
      }
      out.push({ ...to, o: 0, sh: 0 });
    } else {
      // From whatever it had at the start (0 on the origin; something in between
      // when a flight home is turned around) up to full, by where it is — or, if
      // it is already past that range, over a moment.
      const rise = (start: number, at: (r: number) => number) => {
        const a = at(near(from));
        return (r: number, t: number) =>
          start + (1 - start) * (a < 0.999 ? clamp((at(r) - a) / (1 - a), 0, 1) : smoothstep(t / 80));
      };
      const solid = rise(from.o, (r) => solidity(r, FADE_START));
      const shade = rise(from.sh, (r) => smoothstep(r / SHADOW_SPAN));
      for (let i = 0; i < body.length; i++) {
        const r = near(body[i]);
        out.push({ ...body[i], o: solid(r, i * run.dt), sh: shade(r, i * run.dt) });
      }
      out.push({ ...to });
    }
  } else {
    const total = gap(from, to, box);
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      // Off the right edge: nothing left to see.
      if (look === 'leave' && i > 0 && c.x - (c.s * box.w) / 2 > box.w / 2 + OFFSCREEN_CLEAR_PX) break;
      const left = total > 1 ? clamp(gap(c, to, box) / total, 0, 1) : 1 - i / Math.max(1, body.length);
      out.push({ ...c, o: to.o + (from.o - to.o) * left, sh: to.sh + (from.sh - to.sh) * left });
    }
    out.push({ ...to });
  }
  return { path: sampled(out, run.dt), ms: (out.length - 1) * run.dt };
}

// ---------------------------------------------------------------------------
// The page element
// ---------------------------------------------------------------------------

const SHADOW_CSS =
  'pointer-events:none;transform-origin:50% 50%;will-change:transform,opacity;opacity:0;' +
  `border-radius:${CARD_RADIUS}px;` +
  'box-shadow:0 0 0 1px rgb(128 128 128 / 0.22),0 18px 48px rgb(0 0 0 / 0.42);';

/** Elapsed time of a running animation as the screen shows it, ms. */
function elapsed(anim: Animation | undefined, started: number, ms: number): number {
  const t = anim?.currentTime;
  return clamp(typeof t === 'number' ? t : performance.now() - started, 0, ms);
}

/**
 * Owns the page element while it is a card (gesture or flight) and restores it
 * afterwards. Never touches `className` (React owns it) — only `data-back`,
 * inline style, Web Animations it starts, and its own shadow element.
 */
class PageCard {
  el: HTMLElement | null = null;
  box: Box = { left: 0, top: 0, w: 1, h: 1 };
  private shadow: HTMLDivElement | null = null;
  private last: Card | null = null;
  private anims: Animation[] = [];
  private playing: { path: Trajectory<Card>; ms: number; started: number } | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rec = new Recorder<Card>();
  private readonly blend = new Blend<Card>();

  constructor(private readonly resolve: () => HTMLElement | null) {}

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
    s.transformOrigin = '50% 50%';
    // Set once, never animated: the card's corners (see "Cost" above).
    s.clipPath = `inset(0px round ${CARD_RADIUS}px)`;
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

  /** The element directly below the card in paint order that the scrim must go under. */
  get lowest(): HTMLElement | null {
    return this.shadow ?? this.el;
  }

  /** Presented card and its speed (per ms) — mid-animation if one is playing. */
  now(): [Card, Card] {
    const p = this.playing;
    if (p) {
      const t = elapsed(this.anims[0], p.started, p.ms);
      return [p.path(t), speedAt(p.path, t)];
    }
    const last = this.last ?? REST;
    return [last, this.rec.velocity(last)];
  }

  /** Put the card somewhere, still (the pose a flight is about to start from). */
  place(c: Card): void {
    this.stop();
    this.rec.reset();
    this.blend.clear();
    this.last = c;
    this.write(c);
  }

  /** The finger takes over: stop any flight, blending from where it was shown. */
  hold(first: Card): void {
    const shown = this.playing ? this.now()[0] : this.last;
    this.stop();
    this.rec.reset();
    this.blend.from(shown, first);
    // Stopping the flight uncovers the inline pose (its end): keep showing where
    // the card was until the finger's first frame arrives.
    const start = shown ?? first;
    this.last = start;
    this.write(start);
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
    const end = path(ms);
    // The inline pose is what shows if Web Animations are unavailable.
    this.last = end;
    this.write(end);
    this.playing = { path, ms, started: performance.now() };
    if (typeof el.animate !== 'function' || ms <= 0) {
      onDone?.();
      return;
    }
    // transform + opacity only: the compositor plays these by itself.
    const anim = el.animate(
      keyframes(path, ms, (c) => ({ transform: cardTransform(c), opacity: c.o })),
      { duration: ms, fill: 'forwards' },
    );
    this.anims = [anim];
    if (this.shadow) {
      this.anims.push(
        this.shadow.animate(
          keyframes(path, ms, (c) => ({ transform: cardTransform(c), opacity: c.sh * c.o })),
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
    // Backstop: a backgrounded WebView may deliver `finish` late, and a busy
    // first frame may start the animation late.
    this.doneTimer = setTimeout(finish, ms + 250);
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
    const el = this.el;
    this.el = null;
    this.last = null;
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
    const t = cardTransform(c);
    el.style.transform = t;
    el.style.opacity = c.o.toFixed(3);
    if (this.shadow) {
      this.shadow.style.transform = t;
      this.shadow.style.opacity = (c.sh * c.o).toFixed(3);
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
  private playing: { path: Trajectory<Under>; ms: number; started: number; goal: Under } | null = null;
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

  /** Spring to `to` from the presented pose and speed, then let go of the screen. */
  to(to: Under, response: number): void {
    const [from, v] = this.now();
    const run = springPath(from, v, to, {
      response,
      tolerance: (k) => (k === 's' ? 0.0005 : 0.002),
    });
    this.play(run.path, run.ms, to);
  }

  /**
   * Where `rect` (of an element inside this screen, as measured now) will be
   * once the screen is back at its normal scale.
   */
  unscale(el: Element, rect: DOMRect): Rect {
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
    const t = elapsed(this.anims[0], p.started, p.ms);
    return [p.path(t), speedAt(p.path, t)];
  }

  /**
   * The page is gone. A screen on its way back to normal finishes coming
   * forward (it lets go by itself); anything else is dropped now.
   */
  release(): void {
    if (this.playing?.goal === UNDER_SHOWN) return;
    this.cleanupNow();
  }

  private apply(p: Under): void {
    if (!this.el || !this.scrim) return;
    this.last = p;
    this.el.style.transform = `scale(${p.s.toFixed(4)})`;
    this.scrim.style.opacity = p.o.toFixed(3);
  }

  private play(path: Trajectory<Under>, ms: number, goal: Under): void {
    const el = this.el;
    const scrim = this.scrim;
    if (!el || !scrim) return;
    this.stop();
    this.apply(path(ms));
    this.playing = { path, ms, started: performance.now(), goal };
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
      this.cleanupNow();
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
// The origin's answer
// ---------------------------------------------------------------------------

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

/** How strongly the origin is tinted with its own text colour: while the card is held / as it lands. */
const TINT_HELD = 9;
const TINT_LANDING = 22;
/** How long the origin takes to calm down after the card has landed, ms. */
const PULSE_TAIL_MS = 420;

/**
 * The origin's part in the transition: it lights up faintly while the card is
 * held (that is where it will go) and, when the card lands, dips and glows as
 * if it caught it. Done entirely with Web Animations on the origin element — no
 * inline style, no class, no extra element — so nothing can be left behind on
 * an element React owns: cancelling the animations is a complete undo.
 */
class OriginPulse {
  private el: HTMLElement | null = null;
  private base = '';
  private fg = '';
  private tint: Animation | null = null;
  private dip: Animation | null = null;

  private take(el: Element | null): HTMLElement | null {
    if (el === this.el && el) return this.el;
    this.clear();
    if (!(el instanceof HTMLElement) || typeof el.animate !== 'function') return null;
    const cs = getComputedStyle(el);
    this.el = el;
    this.base = cs.backgroundColor;
    this.fg = cs.color;
    return el;
  }

  private lit(percent: number): string {
    const under = alphaOf(this.base) > 0.02 ? this.base : 'transparent';
    return `color-mix(in srgb, ${this.fg} ${percent}%, ${under})`;
  }

  private shownTint(): string {
    return this.el && this.tint ? getComputedStyle(this.el).backgroundColor : this.base;
  }

  private run(el: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
    try {
      return el.animate(frames, options);
    } catch {
      // A colour syntax this engine does not know: the pulse is decoration.
      return null;
    }
  }

  /** The card is held: show where it will go back to. */
  hold(origin: Element | null): void {
    const el = this.take(origin);
    if (!el) return;
    const from = this.shownTint();
    this.tint?.cancel();
    this.dip?.cancel();
    this.dip = null;
    this.tint = this.run(
      el,
      [{ backgroundColor: from }, { backgroundColor: this.lit(TINT_HELD) }],
      { duration: 180, easing: 'ease-out', fill: 'forwards' },
    );
  }

  /** The card lands in `ms`: glow as it arrives, dip as it touches down (`force` 0 … 1), then calm down. */
  land(origin: Element | null, ms: number, force: number): void {
    const el = this.take(origin);
    if (!el) return;
    const from = this.shownTint();
    this.tint?.cancel();
    this.dip?.cancel();
    const touch = Math.max(60, ms * 0.85);
    const total = touch + PULSE_TAIL_MS;
    const k = touch / total;
    const depth = 0.014 + 0.02 * clamp(force, 0, 1);
    this.tint = this.run(
      el,
      [
        { backgroundColor: from, offset: 0, easing: 'ease-in' },
        { backgroundColor: this.lit(TINT_LANDING), offset: k, easing: 'ease-out' },
        { backgroundColor: this.base, offset: 1 },
      ],
      { duration: total },
    );
    // Added on top of whatever transform the origin has of its own.
    this.dip = this.run(
      el,
      [
        { transform: 'scale(1)', offset: 0 },
        { transform: 'scale(1)', offset: k * 0.55, easing: 'ease-in' },
        { transform: `scale(${(1 - depth).toFixed(4)})`, offset: k, easing: 'ease-out' },
        { transform: `scale(${(1 + depth * 0.3).toFixed(4)})`, offset: k + (1 - k) * 0.45, easing: 'ease-in-out' },
        { transform: 'scale(1)', offset: 1 },
      ],
      { duration: total, composite: 'add' },
    );
    // Not filled: both remove themselves when they end.
    const tint = this.tint;
    if (tint) {
      tint.onfinish = () => {
        if (this.tint === tint) this.clear();
      };
    }
  }

  /** The card is going back to full screen: fade the light out. */
  release(): void {
    const el = this.el;
    if (!el || !this.tint) return this.clear();
    const from = this.shownTint();
    this.tint.cancel();
    this.dip?.cancel();
    this.dip = null;
    const tint = this.run(el, [{ backgroundColor: from }, { backgroundColor: this.base }], {
      duration: 200,
      easing: 'ease-out',
    });
    this.tint = tint;
    if (tint) {
      tint.onfinish = () => {
        if (this.tint === tint) this.clear();
      };
    } else this.clear();
  }

  /** The page is gone: a landing pulse plays out, a held light is switched off. */
  settle(): void {
    if (this.dip) return;
    this.clear();
  }

  clear(): void {
    this.tint?.cancel();
    this.dip?.cancel();
    this.tint = null;
    this.dip = null;
    this.el = null;
  }
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

interface Point extends Channels {
  x: number;
  y: number;
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
  const pulse = new OriginPulse();
  const finger = new Recorder<Point>();
  let feel: BackFeel = getBackFeel();
  let origin: Element | null = null;
  /** Where the card will land, measured when the gesture started (nothing is measured at release). */
  let landing: Landing | null = null;
  /** The card on the origin of the last flight home, for a reopen that turns it around. */
  let homeChip: Card | null = null;
  /** A flight home is under way (gesture commit or close). */
  let flyingHome = false;
  /** The page's own close has started this open cycle. */
  let closing = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  /** An opening page waiting for its first paint before it starts to grow. */
  let cancelOpen: (() => void) | null = null;

  // While held: what the finger asks for, and the tilt that trails it.
  let holding = false;
  let heldTarget: Card = REST;
  let underTarget: Under = UNDER_COVERED;
  const tiltX = { p: 0, v: 0 };
  const tiltY = { p: 0, v: 0 };
  let lastStep = 0;
  let swayRaf = 0;

  const clearGrace = () => {
    if (grace != null) clearTimeout(grace);
    grace = null;
  };

  const dropPendingOpen = () => {
    cancelOpen?.();
    cancelOpen = null;
  };

  const stopHolding = () => {
    holding = false;
    if (swayRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(swayRaf);
    swayRaf = 0;
  };

  /** Where the origin is (as it will be once the screen behind is back at rest). */
  function measureOrigin(): Landing | null {
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
    return { el: o, rect: r };
  }

  /**
   * One frame of the held card: size and position go where the finger puts
   * them; the tilt follows on a soft spring (`feel.sway`), so a quick move
   * leans the card and it settles a moment later. True once nothing moves.
   */
  function stepHold(): boolean {
    const now = performance.now();
    const dt = lastStep ? now - lastStep : 16;
    lastStep = now;
    const sway = clamp(feel.sway, 0, 1);
    let settled = true;
    if (sway > 0) {
      const response = 0.14 + 0.12 * sway;
      const damping = 1 - 0.45 * sway;
      springStep(tiltX, heldTarget.rx, response, damping, dt);
      springStep(tiltY, heldTarget.ry, response, damping, dt);
      settled =
        Math.abs(tiltX.p - heldTarget.rx) < 0.05 &&
        Math.abs(tiltY.p - heldTarget.ry) < 0.05 &&
        Math.abs(tiltX.v) * 16 < 0.05 &&
        Math.abs(tiltY.v) * 16 < 0.05;
    } else {
      tiltX.p = heldTarget.rx;
      tiltY.p = heldTarget.ry;
      tiltX.v = tiltY.v = 0;
    }
    card.set({ ...heldTarget, rx: tiltX.p, ry: tiltY.p });
    under.set(underTarget);
    return settled;
  }

  /** Keeps the tilt settling on frames where the finger sends nothing new. */
  function swayOn(): void {
    if (swayRaf || !holding || typeof requestAnimationFrame !== 'function') return;
    swayRaf = requestAnimationFrame(() => {
      swayRaf = 0;
      if (!holding || !card.el) return;
      // A finger frame may already have stepped this display frame.
      const settled = performance.now() - lastStep < 6 ? false : stepHold();
      if (!settled) swayOn();
    });
  }

  /** Release / close: fly from where the card is shown into the origin (or out right). */
  function flyHome(throwV: Point, target: Landing | null): void {
    const el = card.el;
    if (!el) return;
    stopHolding();
    flyingHome = true;
    // On its way out: taps go to the screen it is landing on, not to it.
    el.style.pointerEvents = 'none';
    const [from, v0] = card.now();
    under.begin(getUnder(), el, card.lowest, UNDER_COVERED);
    const chip = target ? chipOn(target.rect, card.box) : null;
    homeChip = chip;
    const to = chip ?? offscreenCard(card.box, from.s);
    // The finger's speed: thrown along with it, and a flick gets home sooner.
    const speed = Math.hypot(throwV.x, throwV.y);
    const force = clamp(speed / FAST_THROW, 0, 1);
    const push = (speed > FAST_THROW ? FAST_THROW / speed : 1) * THROW_GAIN;
    const v: Card = { ...v0, x: v0.x + throwV.x * push, y: v0.y + throwV.y * push };
    const response = feel.flight * (1 - THROW_HURRY * force);
    const { path, ms } = flight(from, v, to, chip ? 'home' : 'leave', response, card.box, chip);
    // The exit class only times the unmount: make it wait for the flight.
    el.style.setProperty('--back-ms', `${Math.round(ms)}ms`);
    // Only a flight that actually plays may hold up the unmount.
    if (typeof el.animate === 'function') holdExitFallback(ms + 80);
    card.play(path, ms, () => {
      // Landed (gone into the origin, or parked off-screen). The page unmounts
      // now; until it does, leave it where it landed.
      card.dropShadow();
      if (!el.isConnected) card.cleanup();
    });
    under.to(UNDER_SHOWN, response);
    if (target) pulse.land(target.el, ms, force);
    else pulse.clear();
  }

  /** Back to full screen from wherever the card is shown. */
  function settleBack(): void {
    stopHolding();
    flyingHome = false;
    if (card.el) card.el.style.pointerEvents = '';
    const [from, vNow] = card.now();
    // Back to rest: keep the position, but not so much speed toward rest that it overshoots.
    const v = absorbable(from, vNow, REST, feel.flight);
    const { path, ms } = flight(from, v, REST, 'plain', feel.flight, card.box);
    card.play(path, ms, () => card.cleanup());
    under.to(UNDER_COVERED, feel.flight);
    pulse.release();
  }

  /** Grow to full screen from `from` (out of `chip`, when there is an origin). */
  function grow(from: Card, v: Card, chip: Card | null): void {
    const { path, ms } = flight(from, v, REST, chip ? 'grow' : 'plain', feel.flight, card.box, chip);
    card.play(path, ms, () => card.cleanup());
    under.to(UNDER_COVERED, feel.flight);
  }

  const preview: BackPreview = {
    start() {
      clearGrace();
      dropPendingOpen();
      feel = getBackFeel();
      if (!card.attach()) return;
      flyingHome = false;
      const el = card.el;
      // Measured now, while nothing moves — release must not wait for a layout.
      landing = measureOrigin();
      under.begin(getUnder(), el, card.lowest, UNDER_COVERED);
      // An interrupted flight is handed over by the blend inside hold(); the
      // tilt spring starts flat on top of that.
      card.hold(REST);
      under.hold(underHeld(0));
      tiltX.p = tiltX.v = tiltY.p = tiltY.v = 0;
      heldTarget = REST;
      underTarget = underHeld(0);
      lastStep = 0;
      holding = true;
      finger.reset();
      pulse.hold(landing?.el ?? null);
    },
    update(frame) {
      if (!card.el || !holding) return;
      finger.push({ x: frame.x, y: frame.y });
      heldTarget = heldCard(cardPose(frame, feel, 1));
      underTarget = underHeld(travel(frame, 0.7));
      if (!stepHold()) swayOn();
    },
    cancel() {
      if (!card.el) return;
      settleBack();
    },
    commit() {
      if (!card.el) return;
      const still: Point = { x: 0, y: 0 };
      const target = landing?.el.isConnected ? landing : measureOrigin();
      flyHome(holding ? finger.velocity(still) : still, target);
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
      dropPendingOpen();
      stopHolding();
      if (prefersReducedMotion()) return;
      const el0 = getEl();
      // Reopened mid-flight: same element, same origin, turn around from where it is.
      const wasOurs = el0 != null && card.el === el0 && card.isPlaying;
      origin = claimOrigin(el0) ?? (wasOurs ? origin : null);
      feel = getBackFeel();
      if (!card.attach()) return;
      const el = card.el;
      if (!el) return;
      flyingHome = false;
      el.style.pointerEvents = '';
      pulse.clear();
      if (wasOurs) {
        const [from, v] = card.now();
        under.begin(getUnder(), el, card.lowest, UNDER_SHOWN);
        grow(from, v, homeChip);
        return;
      }
      // Start on the origin (or parked off the right edge).
      const start = measureOrigin();
      const chip = start ? chipOn(start.rect, card.box) : null;
      const from = chip ?? offscreenCard(card.box, 1);
      under.begin(getUnder(), el, card.lowest, UNDER_SHOWN);
      card.place(from);
      const go = () => {
        cancelOpen = null;
        if (card.el !== el || !el.isConnected) return;
        grow(from, zeroLike(from), chip);
      };
      // Let the page's first paint through before it starts to grow: that
      // frame can be long (the page is mounting), and a motion that starts
      // inside it would lose its beginning. Nothing to wait for without
      // Web Animations (tests).
      if (typeof el.animate === 'function') cancelOpen = afterFrame(go, 160, 2);
      else go();
    },
    exit() {
      if (closing) return;
      closing = true;
      clearGrace();
      dropPendingOpen();
      if (flyingHome || prefersReducedMotion()) return;
      feel = getBackFeel();
      if (!card.attach()) return;
      flyHome({ x: 0, y: 0 }, measureOrigin());
    },
    dispose() {
      clearGrace();
      dropPendingOpen();
      stopHolding();
      flyingHome = false;
      closing = false;
      landing = null;
      card.cleanup();
      under.release();
      pulse.settle();
    },
  };
}

/** Pure pieces, exported for unit tests only. */
export const __pageMotionMath = {
  REST,
  heldCard,
  chipOn,
  offscreenCard,
  cardTransform,
  gap,
  flight,
  UNDER_COVERED,
  FADE_START,
  FADE_END,
  absorbable,
};
