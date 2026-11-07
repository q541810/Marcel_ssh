// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACK_FEEL } from './backFeel';
import {
  draggedY,
  flightHome,
  flightIn,
  flightOut,
  geometry,
  heldY,
  projectedY,
  scrimAt,
  shouldDismiss,
} from './sheetMotion';

const W = 400;
const H = 860;
// A 500px-tall sheet resting on the bottom of an 860px screen.
const G = geometry(H - 500, 500, H);
const RESPONSE = DEFAULT_BACK_FEEL.flight;

beforeEach(() => {
  vi.stubGlobal('innerWidth', W);
  vi.stubGlobal('innerHeight', H);
});

describe('backdrop follows the sheet', () => {
  it('fully bright at rest, gone once the sheet is out of sight, never brighter in between', () => {
    expect(scrimAt(0, G)).toBe(1);
    expect(scrimAt(G.off, G)).toBeCloseTo(0, 6);
    let prev = 1;
    for (let y = 0; y <= G.off; y += 5) {
      const o = scrimAt(y, G);
      expect(o).toBeLessThanOrEqual(prev + 1e-9);
      prev = o;
    }
  });

  it('is continuous (no step where the held range ends)', () => {
    const a = scrimAt(G.hold - 0.01, G);
    const b = scrimAt(G.hold + 0.01, G);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });
});

describe('held back swipe', () => {
  const at = (share: number) => heldY({ dx: W * share }, G, DEFAULT_BACK_FEEL);

  it('only ever sinks, never past the held range', () => {
    for (let dx = 0; dx <= W; dx += 10) {
      const y = heldY({ dx }, G, DEFAULT_BACK_FEEL);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(G.hold + 1e-9);
    }
  });

  it('is front-loaded: quick first, slower through the middle, almost still at the end', () => {
    expect(at(0.1)).toBeGreaterThan(G.hold * 0.3);
    const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map(at);
    for (let i = 2; i < steps.length; i++) {
      expect(steps[i] - steps[i - 1]).toBeLessThan(steps[i - 1] - steps[i - 2]);
    }
    expect(at(0.5)).toBeCloseTo(G.hold, 6);
    expect(at(1)).toBeCloseTo(G.hold, 6);
  });
});

describe('pulling the handle', () => {
  it('follows the finger 1:1 downward, with only a short give upward', () => {
    expect(draggedY(120)).toBe(120);
    expect(draggedY(-400)).toBeGreaterThan(-28);
    expect(draggedY(-400)).toBeLessThan(0);
  });

  it('a short slow pull returns, a long pull or a flick dismisses', () => {
    expect(shouldDismiss(30, 0, 500)).toBe(false);
    expect(shouldDismiss(30, -800, 500)).toBe(false);
    expect(shouldDismiss(260, 0, 500)).toBe(true);
    // A small movement but flung downward.
    expect(shouldDismiss(30, 700, 500)).toBe(true);
    expect(projectedY(0, 1000)).toBeCloseTo(499, 0);
  });
});

describe('flights', () => {
  it('leave from exactly where the sheet is, at the speed it has', () => {
    const v = 0.4; // px/ms
    const { path } = flightOut(120, v, G, RESPONSE);
    expect(path(0).y).toBe(120);
    const still = flightOut(120, 0, G, RESPONSE).path;
    expect((path(4).y - still(4).y) / 4).toBeCloseTo(v, 1);
  });

  it('go out the way they came (down), end out of sight, and are never slower to start than to finish', () => {
    const { path, ms } = flightOut(0, 0, G, RESPONSE);
    expect(path(ms).y).toBeGreaterThanOrEqual(G.off);
    let prev = 0;
    for (let t = 0; t <= ms; t += 4) {
      const y = path(t).y;
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
    // Leaves briskly: gone well within half a second.
    expect(ms).toBeLessThan(500);
    // No ease-in lag: the first tenth of the time already covers real ground.
    expect(path(ms * 0.1).y).toBeGreaterThan(G.off * 0.03);
  });

  it('a harder flick leaves sooner than a drop from rest', () => {
    const rest = flightOut(0, 0, G, RESPONSE).ms;
    const flick = flightOut(60, 2.5, G, RESPONSE).ms;
    expect(flick).toBeLessThan(rest);
  });

  it('a flight from already-out-of-sight still finishes (does not hang the unmount)', () => {
    const { ms } = flightOut(G.off + 10, 0, G, RESPONSE);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });

  it('return to rest from a held pose, without overshooting past it', () => {
    const { path, ms } = flightHome(80, 0.3, RESPONSE);
    expect(path(0).y).toBe(80);
    expect(path(ms).y).toBe(0);
    for (let t = 0; t <= ms; t += 4) expect(path(t).y).toBeGreaterThan(-8);
  });

  it('rise into place from below the screen and settle exactly at rest, no bounce', () => {
    const { path, ms } = flightIn(G.off, 0, RESPONSE);
    expect(path(0).y).toBe(G.off);
    expect(path(ms).y).toBe(0);
    for (let t = 0; t <= ms; t += 4) expect(path(t).y).toBeGreaterThanOrEqual(-0.5);
  });

  it('the backdrop is never brighter on the way out than the sheet position allows', () => {
    const { path, ms } = flightOut(60, 0.2, G, RESPONSE);
    let prev = scrimAt(60, G);
    for (let t = 0; t <= ms; t += 4) {
      const o = scrimAt(path(t).y, G);
      expect(o).toBeLessThanOrEqual(prev + 1e-9);
      prev = o;
    }
    expect(prev).toBeCloseTo(0, 6);
  });
});
