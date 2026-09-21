/**
 * Mobile xterm fling / momentum scroll.
 * xterm 5.x touch path only does follow-finger scrollTop writes (no inertia).
 * This module adds lift-off fling via public scrollLines API.
 */

import {
  createLineAccumulator,
  measureRowHeightPx,
  type ScrollPoint,
} from '@/lib/terminalScrollGesture';

export interface VelocitySample {
  t: number;
  /** pageY; higher = finger lower on screen */
  y: number;
}

/** Positive velocity = scroll content down (increase ydisp / scrollTop), same sign as xterm touch deltaY. */
export function estimateScrollVelocity(
  samples: VelocitySample[],
  windowMs = 100,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const cutoff = last.t - windowMs;
  // Oldest sample still inside [cutoff, last.t]; ignore older points.
  let firstIdx = samples.length - 1;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (samples[i]!.t < cutoff) break;
    firstIdx = i;
  }
  if (firstIdx === samples.length - 1) {
    // All but last are older than the window — fall back to previous sample.
    firstIdx = samples.length - 2;
  }
  const first = samples[firstIdx]!;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  // Finger moves up → y decreases → content scrolls down → positive
  return (first.y - last.y) / dt;
}

export interface FlingStepInput {
  velocityPxPerMs: number;
  dtMs: number;
  /** Exponential decay rate (1/ms). ~0.003 feels close to Android list fling. */
  frictionPerMs: number;
}

export interface FlingStepResult {
  velocityPxPerMs: number;
  deltaPx: number;
}

export function stepFling(input: FlingStepInput): FlingStepResult {
  const dt = Math.max(0, input.dtMs);
  if (dt === 0 || input.velocityPxPerMs === 0) {
    return { velocityPxPerMs: input.velocityPxPerMs, deltaPx: 0 };
  }
  const v0 = input.velocityPxPerMs;
  const decay = Math.exp(-input.frictionPerMs * dt);
  const v1 = v0 * decay;
  // Integrate exponential: Δ = v0 * (1 - e^{-k·dt}) / k
  const k = input.frictionPerMs;
  const deltaPx = k > 0 ? (v0 * (1 - decay)) / k : v0 * dt;
  return { velocityPxPerMs: v1, deltaPx };
}

export interface FlingConfig {
  /** Min |velocity| (px/ms) to start fling after touchend. */
  minVelocityPxPerMs: number;
  /** Stop fling when |velocity| falls below this. */
  stopVelocityPxPerMs: number;
  frictionPerMs: number;
  /** Ignore fling if total |vertical| travel below this (px). */
  minTravelPx: number;
  /** If |dx| > |dy| * ratio, treat as horizontal and skip fling. */
  maxHorizontalRatio: number;
  velocityWindowMs: number;
}

export const DEFAULT_FLING_CONFIG: Readonly<FlingConfig> = {
  minVelocityPxPerMs: 0.25,
  stopVelocityPxPerMs: 0.03,
  frictionPerMs: 0.003,
  minTravelPx: 8,
  maxHorizontalRatio: 1.2,
  velocityWindowMs: 100,
};

export function shouldStartFling(args: {
  velocityPxPerMs: number;
  travelY: number;
  travelX: number;
  hasSelection: boolean;
  config?: Partial<FlingConfig>;
}): boolean {
  const cfg = { ...DEFAULT_FLING_CONFIG, ...args.config };
  if (args.hasSelection) return false;
  if (Math.abs(args.velocityPxPerMs) < cfg.minVelocityPxPerMs) return false;
  if (Math.abs(args.travelY) < cfg.minTravelPx) return false;
  if (
    Math.abs(args.travelX) >
    Math.abs(args.travelY) * cfg.maxHorizontalRatio
  ) {
    return false;
  }
  // Velocity should agree with travel direction (no reverse fling from jitter).
  if (args.velocityPxPerMs * args.travelY <= 0) return false;
  return true;
}

export interface MomentumScrollHandle {
  dispose: () => void;
  /** Cancel in-flight fling (e.g. before dispose or programmatic scroll). */
  stop: () => void;
}

/** Minimal terminal surface this gesture needs (structural, so tests can fake it). */
export interface MomentumScrollTerminal {
  scrollLines: (amount: number) => void;
  rows: number;
  hasSelection: () => boolean;
  buffer: { active: { viewportY: number; type: 'normal' | 'alternate' } };
}

export interface AttachMomentumScrollOptions {
  getTerminal: () => MomentumScrollTerminal | null;
  /** Root that contains .xterm (usually the open() host element). */
  container: HTMLElement;
  /**
   * 备用屏幕里本地没有回滚缓冲，`term.scrollLines()` 是空转（xterm 自己的
   * follow-finger 也一起空转）：follow-finger 与甩动都改交给它转发给远端程序
   * （tmux / vim / less 自己滚），见 terminalScrollGesture。
   */
  forwardRemoteScroll?: (lines: number, at: ScrollPoint) => void;
  config?: Partial<FlingConfig>;
  /** clock for tests */
  now?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

/**
 * Listen on container; after a vertical flick, keep scrolling via scrollLines
 * until velocity dies or buffer edge is hit. Does not replace xterm's
 * follow-finger touchmove handling.
 */
export function attachXtermMomentumScroll(
  options: AttachMomentumScrollOptions,
): MomentumScrollHandle {
  const cfg = { ...DEFAULT_FLING_CONFIG, ...options.config };
  const now = options.now ?? (() => performance.now());
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = options.caf ?? ((id) => cancelAnimationFrame(id));

  let samples: VelocitySample[] = [];
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let flingRaf: number | null = null;
  let velocity = 0;
  let lastFrameT = 0;
  /** 最近一次手指落点：备用屏幕里它就是滚轮报告的位置（多窗格时决定滚哪个）。 */
  let lastPoint: ScrollPoint = { clientX: 0, clientY: 0 };
  /** 上一次 touchmove 的 clientY，用来算备用屏幕里的手指位移。 */
  let lastFingerY: number | null = null;

  const accumulator = createLineAccumulator(() =>
    measureRowHeightPx(options.container, options.getTerminal()?.rows ?? 0),
  );

  const stop = () => {
    if (flingRaf !== null) {
      caf(flingRaf);
      flingRaf = null;
    }
    velocity = 0;
    accumulator.reset();
  };

  /**
   * 备用屏幕里本地滚不动（没有回滚缓冲），交给远端程序自己滚。
   * @returns 是否已按远端滚动处理（false = 照旧走本地 scrollLines）。
   */
  const forwardToRemote = (
    term: MomentumScrollTerminal,
    lines: number,
    at: ScrollPoint,
  ): boolean => {
    const forward = options.forwardRemoteScroll;
    if (!forward || term.buffer.active.type !== 'alternate') return false;
    forward(lines, at);
    return true;
  };

  const tick = (t: number) => {
    flingRaf = null;
    const term = options.getTerminal();
    if (!term || Math.abs(velocity) < cfg.stopVelocityPxPerMs) {
      stop();
      return;
    }
    const dt = Math.min(32, Math.max(0, t - lastFrameT));
    lastFrameT = t;
    const stepped = stepFling({
      velocityPxPerMs: velocity,
      dtMs: dt,
      frictionPerMs: cfg.frictionPerMs,
    });
    velocity = stepped.velocityPxPerMs;
    const lines = accumulator.add(stepped.deltaPx);
    if (lines !== 0 && !forwardToRemote(term, lines, lastPoint)) {
      const before = term.buffer.active.viewportY;
      term.scrollLines(lines);
      const after = term.buffer.active.viewportY;
      if (after === before) {
        stop();
        return;
      }
    }
    if (Math.abs(velocity) < cfg.stopVelocityPxPerMs) {
      stop();
      return;
    }
    flingRaf = raf(tick);
  };

  const onTouchStart = (ev: TouchEvent) => {
    stop();
    if (ev.touches.length !== 1) {
      tracking = false;
      samples = [];
      lastFingerY = null;
      return;
    }
    const touch = ev.touches[0]!;
    tracking = true;
    startX = touch.pageX;
    startY = touch.pageY;
    lastFingerY = touch.clientY;
    lastPoint = { clientX: touch.clientX, clientY: touch.clientY };
    samples = [{ t: now(), y: touch.pageY }];
  };

  const onTouchMove = (ev: TouchEvent) => {
    if (!tracking || ev.touches.length !== 1) return;
    const touch = ev.touches[0]!;
    const t = now();
    samples.push({ t, y: touch.pageY });
    // Cap sample buffer
    if (samples.length > 32) samples = samples.slice(-24);

    lastPoint = { clientX: touch.clientX, clientY: touch.clientY };
    // 备用屏幕（tmux / vim / less）：xterm 自己的 follow-finger 在那边是空转，
    // 这里代替它把手指位移折算成行数转给远端程序。
    const term = options.getTerminal();
    const previousY = lastFingerY;
    lastFingerY = touch.clientY;
    if (!term || previousY === null) return;
    const lines = accumulator.add(previousY - touch.clientY);
    if (lines !== 0) forwardToRemote(term, lines, lastPoint);
  };

  const onTouchEnd = (ev: TouchEvent) => {
    if (!tracking) return;
    tracking = false;
    if (ev.touches.length > 0) {
      samples = [];
      return;
    }
    const term = options.getTerminal();
    if (!term) {
      samples = [];
      return;
    }
    const end = ev.changedTouches[0];
    if (!end) {
      samples = [];
      return;
    }
    const t = now();
    samples.push({ t, y: end.pageY });
    const travelY = startY - end.pageY; // same sign as scroll velocity
    const travelX = end.pageX - startX;
    const v = estimateScrollVelocity(samples, cfg.velocityWindowMs);
    samples = [];
    lastFingerY = null;
    if (
      !shouldStartFling({
        velocityPxPerMs: v,
        travelY,
        travelX,
        hasSelection: term.hasSelection(),
        config: cfg,
      })
    ) {
      return;
    }
    velocity = v;
    lastFrameT = t;
    flingRaf = raf(tick);
  };

  const onTouchCancel = () => {
    tracking = false;
    samples = [];
    lastFingerY = null;
    stop();
  };

  const el = options.container;
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return {
    stop,
    dispose: () => {
      stop();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    },
  };
}
