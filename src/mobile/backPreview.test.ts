// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACK_FEEL } from './backFeel';
import { __backPreviewMath as M } from './backPreview';
import type { BackGestureFrame } from './backHandler';

const W = 400;
const H = 860;

beforeEach(() => {
  vi.stubGlobal('innerWidth', W);
  vi.stubGlobal('innerHeight', H);
});

/** A frame of a swipe from `edge`, finger `dx` px in, at height `y`. */
function frame(edge: 'left' | 'right', dx: number, y = H / 2, dy = 0): BackGestureFrame {
  return { progress: dx / W, edge, dx, dy, x: edge === 'left' ? dx : W - dx, y };
}

const feel = DEFAULT_BACK_FEEL;
const REST = { x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1 };

describe('held card', () => {
  it('never leans or drifts back toward the edge the swipe came from', () => {
    for (let dx = 1; dx <= W; dx += 7) {
      for (const y of [40, H / 2, H - 40]) {
        const r = M.cardPose(frame('right', dx, y), feel, 1);
        expect(r.x).toBeLessThanOrEqual(0);
        expect(r.ry).toBeLessThanOrEqual(0);
        const l = M.cardPose(frame('left', dx, y), feel, 1);
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.ry).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('turns noticeably from the first stretch and fully by mid-swipe', () => {
    expect(Math.abs(M.cardPose(frame('right', W * 0.1), feel, 1).ry)).toBeGreaterThan(feel.turn * 0.3);
    expect(Math.abs(M.cardPose(frame('right', W * 0.6), feel, 1).ry)).toBeCloseTo(feel.turn, 5);
  });

  it('leads vertically with pitch; vertical travel stays a small supporting move', () => {
    const top = M.cardPose(frame('right', W * 0.5, 60, -300), feel, 1);
    const bottom = M.cardPose(frame('right', W * 0.5, H - 60, 300), feel, 1);
    // Finger in the top half presses the top in (rotateX > 0), bottom half the bottom.
    expect(top.rx).toBeGreaterThan(feel.pitch * 0.9);
    expect(bottom.rx).toBeLessThan(-feel.pitch * 0.9);
    expect(Math.abs(top.y)).toBeLessThanOrEqual(feel.lift);
    expect(Math.abs(bottom.y)).toBeLessThanOrEqual(feel.lift);
  });

  it('responds front-loaded: quick at first, slower through the middle, almost still at the end', () => {
    const at = (share: number) => M.cardPose(frame('right', W * share), feel, 1);
    const lost = (share: number) => 1 - at(share).s;
    const total = lost(1);
    expect(total).toBeCloseTo(feel.shrink, 5);
    // The first fifth already does a good part of the work…
    expect(lost(0.2)).toBeGreaterThan(total * 0.3);
    // …each further stretch adds less than the one before…
    const steps = [0, 0.2, 0.4, 0.6, 0.8, 1].map(lost);
    for (let i = 2; i < steps.length; i++) {
      expect(steps[i] - steps[i - 1]).toBeLessThan(steps[i - 1] - steps[i - 2]);
    }
    // …and the last fifth barely changes anything.
    expect(total - lost(0.8)).toBeLessThan(total * 0.06);
    // Drift is shaped the same way, never beyond its set share of the width.
    for (let dx = 0; dx <= W; dx += 10) {
      expect(Math.abs(M.cardPose(frame('right', dx), feel, 1).x)).toBeLessThanOrEqual(W * feel.shift + 1e-9);
    }
  });

  it('follow = 1 gives an even response all the way', () => {
    const even = { ...feel, follow: 1 };
    const lost = (share: number) => 1 - M.cardPose(frame('right', W * share), even, 1).s;
    expect(lost(0.5)).toBeCloseTo(even.shrink * 0.5, 5);
  });
});

describe('release continuity', () => {
  const from = { x: -20, y: 4, s: 0.75, rx: 14, ry: -26, o: 1 };
  // Realistic on-screen speeds at release (the drift is small, so x moves slowly).
  const v = { x: -0.08, y: 0.01, s: -0.0004, rx: 0.02, ry: -0.05, o: 0 };

  it('the throw starts exactly at the held pose, at the held speed', () => {
    const to = M.throwTarget(from, -1, feel, 1);
    const path = M.hermite(from, v, to, 340);
    expect(path(0)).toEqual(from);
    const step = path(2);
    expect((step.x - from.x) / 2).toBeCloseTo(v.x, 1);
    expect((step.ry - from.ry) / 2).toBeCloseTo(v.ry, 1);
    expect(path(340).x).toBeCloseTo(to.x, 6);
  });

  it('keeps and deepens the angles instead of straightening them', () => {
    const to = M.throwTarget(from, -1, feel, 1);
    expect(Math.sign(to.ry)).toBe(-1);
    expect(Math.abs(to.ry)).toBeGreaterThan(Math.abs(from.ry));
    expect(to.rx).toBeGreaterThan(from.rx);
    expect(to.x).toBeLessThan(from.x);
    expect(to.s).toBeLessThan(from.s);
  });

  it('fades only in the last part of the throw', () => {
    const path = M.fadingOut(M.hermite(from, v, M.throwTarget(from, -1, feel, 1), 340), 340, 0.4);
    expect(path(100).o).toBe(1);
    expect(path(340).o).toBeCloseTo(0, 6);
  });

  it('the cancel spring starts at the held pose and settles at rest', () => {
    const { path, ms } = M.spring(from, v, REST);
    expect(path(0)).toEqual(from);
    const end = path(ms);
    expect(end.x).toBeCloseTo(0, 1);
    expect(end.ry).toBeCloseTo(0, 1);
    expect(end.s).toBeCloseTo(1, 2);
    expect(ms).toBeLessThan(1200);
  });
});

describe('softLimit', () => {
  it('is near-linear when small and never passes the limit', () => {
    expect(M.softLimit(5, 100)).toBeCloseTo(5, 0);
    expect(M.softLimit(10_000, 100)).toBeLessThanOrEqual(100);
    expect(M.softLimit(-10_000, 100)).toBeGreaterThanOrEqual(-100);
  });
});
