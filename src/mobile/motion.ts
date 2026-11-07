/**
 * Small motion toolkit shared by the predictive-back previews and page
 * transitions (`backPreview.ts`, `pageMotion.ts`): pure math over plain
 * records of numbers ("channels"), plus a velocity recorder.
 *
 * Every animation in those files is a trajectory — a function from elapsed ms
 * to a record of channel values — sampled into Web Animations keyframes, so it
 * plays on the compositor while React is busy, and can be interrupted at any
 * moment by reading the trajectory at the current time (presented value and
 * speed), which is what the next motion starts from.
 */

export type Channels = Record<string, number>;

/** A record of channel values over time, `t` in ms from the start of the motion. */
export type Trajectory<T extends Channels> = (t: number) => T;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Decelerating response 0 … 1: the first part of a swipe already reads clearly. */
export function ease(t: number): number {
  const c = clamp(t, 0, 1);
  return 1 - (1 - c) * (1 - c);
}

/**
 * Front-loaded response 0 … 1 for a share `t` of the way: the first stretch
 * does most of the work, the middle slows, the end hardly moves. `k` = 1 is
 * even; higher is more front-loaded (1 − (1 − t)ᵏ).
 */
export function frontLoaded(t: number, k: number): number {
  return 1 - Math.pow(1 - clamp(t, 0, 1), Math.max(1, k));
}

export function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * Damping: ≈ `v` while small, then ever harder to pull, approaching ±`limit`
 * but never reaching it. Lets motion stay generous without leaving the screen.
 */
export function softLimit(v: number, limit: number): number {
  return limit > 0 ? limit * Math.tanh(v / limit) : 0;
}

export function mapChannels<T extends Channels>(ref: T, f: (k: keyof T & string) => number): T {
  const out = {} as Channels;
  for (const k of Object.keys(ref)) out[k] = f(k as keyof T & string);
  return out as T;
}

export function zeroLike<T extends Channels>(ref: T): T {
  return mapChannels(ref, () => 0);
}

/** Largest initial push (as a multiple of the distance) a Hermite throw accepts. */
const MAX_TANGENT = 2.5;

/**
 * From `from` (moving at `v` per ms) to `to`, arriving at rest after `ms`: a
 * cubic Hermite curve per channel, so the start speed matches what was on
 * screen exactly and the end eases out. Pushes are capped (to a multiple of the
 * distance plus `floor`) so a jittery reading can't fling past the target.
 */
export function hermite<T extends Channels>(
  from: T,
  v: T,
  to: T,
  ms: number,
  floor: Partial<T> = {},
): Trajectory<T> {
  const m = mapChannels(from, (k) => {
    const cap = MAX_TANGENT * Math.abs(to[k] - from[k]) + ((floor[k] as number | undefined) ?? 0);
    return clamp(v[k] * ms, -cap, cap);
  });
  return (t) => {
    const u = clamp(t / ms, 0, 1);
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    return mapChannels(from, (k) => h00 * from[k] + h10 * m[k] + h01 * to[k]);
  };
}

/**
 * A spring started from a position and speed: keep the position (no jump) but
 * limit a speed that points at the target to what the spring can absorb without
 * shooting past it. Used for settling back to rest — a finger returning to its
 * starting point is moving toward rest fast, and a spring that kept all of that
 * speed would overshoot rest and visibly bounce.
 */
export function absorbable<T extends Channels>(from: T, v: T, to: T, response: number): T {
  const omega = (2 * Math.PI) / (response * 1000);
  return mapChannels(v, (k) => {
    const gap = to[k] - from[k];
    const toward = v[k] * Math.sign(gap);
    if (toward <= 0) return v[k];
    return Math.sign(gap) * Math.min(toward, omega * Math.abs(gap));
  });
}

export interface SpringOptions<T extends Channels> {
  /**
   * Apple's "response": roughly how long the spring takes to get there, s. It
   * is not a fixed duration — the settle time falls out of the physics.
   */
  response: number;
  /** Damping ratio per channel (1 = no overshoot); missing channels use 1. */
  damping?: Partial<Record<keyof T, number>>;
  /** Settled when every channel is this close to its target (and nearly still). */
  tolerance: (k: keyof T & string) => number;
  /** Simulation cap, ms. */
  maxMs?: number;
}

export interface SpringRun<T extends Channels> {
  path: Trajectory<T>;
  ms: number;
  /** One sample per `dt` ms, last one exactly `to`. */
  samples: T[];
  dt: number;
}

/**
 * Damped spring from `from` (moving at `v` per ms) toward `to`, one independent
 * spring per channel (so x and y never fall out of step, §3), simulated ahead
 * of time so it can be played as keyframes and read back at any moment.
 */
export function springPath<T extends Channels>(
  from: T,
  v: T,
  to: T,
  opts: SpringOptions<T>,
): SpringRun<T> {
  const dt = 4;
  const omega = (2 * Math.PI) / (opts.response * 1000);
  const maxSteps = Math.ceil((opts.maxMs ?? 1600) / dt);
  const samples: T[] = [];
  const pos = { ...from } as Channels;
  const vel = { ...v } as Channels;
  const keys = Object.keys(from) as Array<keyof T & string>;
  for (let i = 0; i < maxSteps; i++) {
    samples.push({ ...pos } as T);
    let settled = true;
    for (const k of keys) {
      const zeta = (opts.damping?.[k] as number | undefined) ?? 1;
      const a = -omega * omega * (pos[k] - to[k]) - 2 * zeta * omega * vel[k];
      vel[k] += a * dt;
      pos[k] += vel[k] * dt;
      const tol = opts.tolerance(k);
      if (Math.abs(pos[k] - to[k]) > tol || Math.abs(vel[k]) * 16 > tol) settled = false;
    }
    if (settled && i > 2) break;
  }
  samples.push({ ...to });
  const ms = (samples.length - 1) * dt;
  return { ms, samples, dt, path: sampled(samples, dt) };
}

/** Linear interpolation over evenly spaced samples. */
export function sampled<T extends Channels>(samples: T[], dt: number): Trajectory<T> {
  return (t) => {
    const f = clamp(t / dt, 0, samples.length - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, samples.length - 1);
    const r = f - i;
    return mapChannels(samples[i], (k) => samples[i][k] + (samples[j][k] - samples[i][k]) * r);
  };
}

/** Speed of a trajectory at `t` (per ms), by central difference. */
export function speedAt<T extends Channels>(path: Trajectory<T>, t: number): T {
  const a = path(Math.max(0, t - 4));
  const b = path(t + 4);
  return mapChannels(a, (k) => (b[k] - a[k]) / 8);
}

/** Keyframes sampled once per display frame, played linearly. */
export function keyframes<T extends Channels>(
  path: Trajectory<T>,
  ms: number,
  render: (p: T) => Keyframe,
): Keyframe[] {
  const n = Math.max(2, Math.ceil(ms / 16));
  const out: Keyframe[] = [];
  for (let i = 0; i <= n; i++) out.push({ ...render(path((ms * i) / n)), offset: i / n });
  return out;
}

/** Window over which the on-screen speed is measured at release. */
const VELOCITY_WINDOW_MS = 80;

/** Recent values, for the on-screen speed at the moment of release (§5). */
export class Recorder<T extends Channels> {
  private log: Array<{ t: number; p: T }> = [];

  reset(): void {
    this.log = [];
  }

  push(p: T): void {
    const t = performance.now();
    this.log.push({ t, p });
    while (this.log.length > 2 && t - this.log[0].t > VELOCITY_WINDOW_MS * 2) this.log.shift();
  }

  /** Per-ms speed over the last window; still if nothing has moved lately. */
  velocity(ref: T): T {
    const now = performance.now();
    const last = this.log[this.log.length - 1];
    if (!last || now - last.t > VELOCITY_WINDOW_MS) return zeroLike(ref);
    let first = last;
    for (const e of this.log) {
      if (last.t - e.t <= VELOCITY_WINDOW_MS) {
        first = e;
        break;
      }
    }
    const dt = last.t - first.t;
    if (dt < 8) return zeroLike(ref);
    return mapChannels(ref, (k) => (last.p[k] - first.p[k]) / dt);
  }
}

/**
 * Hand-over from an interrupted animation to a finger-driven pose: the gap
 * between where the element was shown and where the finger puts it decays to
 * nothing over a few frames instead of jumping (the web version of iOS's
 * additive animations).
 */
export class Blend<T extends Channels> {
  private offset: T | null = null;
  private t0 = 0;

  constructor(private readonly tauMs = 90) {}

  /** Start blending from `shown` toward whatever `apply` is given next. */
  from(shown: T | null, first: T): void {
    if (!shown) {
      this.offset = null;
      return;
    }
    this.offset = mapChannels(first, (k) => shown[k] - first[k]);
    this.t0 = performance.now();
  }

  apply(p: T): T {
    const off = this.offset;
    if (!off) return p;
    const k = Math.exp(-(performance.now() - this.t0) / this.tauMs);
    if (k < 0.01) {
      this.offset = null;
      return p;
    }
    return mapChannels(p, (c) => p[c] + off[c] * k);
  }

  clear(): void {
    this.offset = null;
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}
