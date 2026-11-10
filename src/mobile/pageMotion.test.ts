// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __pageMotionMath as M, type Box, type Card } from './pageMotion';
import { __resetOrigin, claimOrigin } from './pageOrigin';

const B: Box = { left: 0, top: 0, w: 390, h: 788 };
/** A full-width settings row, a little below the middle of the screen. */
const ROW = { left: 12, top: 419, width: 366, height: 67 };
const ZERO: Card = { x: 0, y: 0, s: 0, rx: 0, ry: 0, o: 0, sh: 0 };

describe('card geometry', () => {
  it('lands as the whole page shrunk to fit inside the origin, centred on it', () => {
    const c = M.chipOn(ROW, B);
    // A wide row: the page fits by height.
    expect(c.s).toBeCloseTo(ROW.height / B.h);
    expect(B.w * c.s).toBeLessThanOrEqual(ROW.width);
    expect(B.left + B.w / 2 + c.x).toBeCloseTo(ROW.left + ROW.width / 2);
    expect(B.top + B.h / 2 + c.y).toBeCloseTo(ROW.top + ROW.height / 2);
    // By then it is gone: the origin shows in its place.
    expect(c.o).toBe(0);
  });

  it('a narrow origin fits by width; a tiny one still gets a card, not a dot', () => {
    expect(M.chipOn({ left: 100, top: 100, width: 40, height: 400 }, B).s).toBeCloseTo(40 / B.w);
    expect(M.chipOn({ left: 0, top: 0, width: 6, height: 6 }, B).s).toBeGreaterThanOrEqual(0.04);
  });

  it('the held card at rest is the page itself', () => {
    const c = M.heldCard({ x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1 });
    expect(c).toEqual(M.REST);
    expect(M.cardTransform(c)).toContain('translate3d(0.00px, 0.00px, 0)');
    expect(M.cardTransform(c)).toContain('scale(1.00000)');
  });

  it('every pose is one transform list (nothing a flight would have to repaint)', () => {
    const shape = (c: Card) => M.cardTransform(c).replace(/-?\d+(\.\d+)?/g, '#');
    const a = shape(M.REST);
    expect(shape(M.chipOn(ROW, B))).toBe(a);
    expect(shape(M.heldCard({ x: -12, y: 4, s: 0.7, rx: 6, ry: -14, o: 1 }))).toBe(a);
  });
});

describe('flights', () => {
  const held = M.heldCard({ x: -20, y: 4, s: 0.72, rx: 8, ry: -3, o: 1 });
  const v: Card = { ...ZERO, x: -0.12, y: 0.05, s: -0.002, ry: -0.04 };
  const chip = M.chipOn(ROW, B);
  const near = (c: Card) => M.gap(c, chip, B) / M.gap(M.REST, chip, B);

  it('flies home from exactly the held pose, at the held speed, into the origin', () => {
    const { path, ms } = M.flight(held, v, chip, 'home', 0.46, B, chip);
    expect(path(0)).toEqual(held);
    // The hand-over carries the speed on screen: compared with a flight that
    // starts still, the first step is ahead by exactly that speed.
    const still = M.flight(held, { ...ZERO }, chip, 'home', 0.46, B, chip).path;
    expect((path(4).x - still(4).x) / 4).toBeCloseTo(v.x, 1);
    expect((path(4).s - still(4).s) / 4).toBeCloseTo(v.s, 3);
    expect(path(ms)).toEqual({ ...chip, o: 0, sh: 0 });
  });

  it('only ever shrinks on the way home (never grows back before landing)', () => {
    const { path, ms } = M.flight(held, { ...ZERO }, chip, 'home', 0.46, B, chip);
    let prev = held.s;
    for (let t = 0; t <= ms; t += 4) {
      const s = path(t).s;
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });

  it('stays solid until it is small and on the origin, then melts — nothing fades in mid-air', () => {
    const { path, ms } = M.flight(held, v, chip, 'home', 0.46, B, chip);
    let prev = 1;
    for (let t = 0; t <= ms; t += 4) {
      const c = path(t);
      if (near(c) > M.FADE_START) expect(c.o).toBe(1);
      // While it is melting it is already a small card.
      if (c.o < 0.99) expect(c.s).toBeLessThan(0.3);
      expect(c.o).toBeLessThanOrEqual(prev + 1e-9);
      prev = c.o;
    }
    expect(prev).toBe(0);
  });

  it('ends when the card is gone instead of waiting out the spring', () => {
    const { ms } = M.flight(held, { ...ZERO }, chip, 'home', 0.46, B, chip);
    const whole = M.flight(held, { ...ZERO }, chip, 'plain', 0.46, B).ms;
    expect(ms).toBeLessThan(whole * 0.8);
    expect(ms).toBeLessThan(460);
  });

  it('a flight that starts right next to the origin does not blink out', () => {
    const close: Card = { ...chip, x: chip.x + 6, s: chip.s + 0.03, o: 1, sh: 1 };
    const { path } = M.flight(close, { ...ZERO }, chip, 'home', 0.46, B, chip);
    expect(path(0).o).toBe(1);
    expect(path(4).o).toBeGreaterThan(0.8);
  });

  it('tilts unwind to flat as it lands', () => {
    const { path, ms } = M.flight(held, v, chip, 'home', 0.46, B, chip);
    expect(Math.abs(path(ms * 0.9).ry)).toBeLessThan(1);
    expect(path(ms).ry).toBe(0);
  });

  it('growing out of the origin is the mirror: invisible on it, solid within the first stretch', () => {
    const { path, ms } = M.flight(chip, { ...ZERO }, M.REST, 'grow', 0.46, B, chip);
    expect(path(0).o).toBe(0);
    let prev = 0;
    for (let t = 0; t <= ms; t += 4) {
      const c = path(t);
      if (near(c) > M.FADE_START) expect(c.o).toBe(1);
      expect(c.o).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(c.s).toBeLessThanOrEqual(1 + 1e-6);
      prev = c.o;
    }
    expect(path(ms)).toEqual(M.REST);
  });

  it('reopened in mid-flight, it turns around from where it is without a jump in opacity', () => {
    const home = M.flight(held, { ...ZERO }, chip, 'home', 0.46, B, chip);
    const at = home.path(home.ms * 0.8);
    const back = M.flight(at, { ...ZERO }, M.REST, 'grow', 0.46, B, chip);
    expect(back.path(0)).toEqual(at);
    expect(Math.abs(back.path(4).o - at.o)).toBeLessThan(0.05);
  });

  it('a fast return to rest does not overshoot it (no bump at the end of a cancel)', () => {
    const nearRest: Card = { ...M.REST, s: 0.97, x: -6 };
    // Moving home faster than the spring can absorb.
    const fast: Card = { ...ZERO, x: 0.4, s: 0.004 };
    const { path, ms } = M.flight(nearRest, M.absorbable(nearRest, fast, M.REST, 0.46), M.REST, 'plain', 0.46, B);
    for (let t = 0; t <= ms; t += 4) {
      const c = path(t);
      expect(c.s).toBeLessThanOrEqual(1 + 1e-3);
      expect(c.x).toBeLessThanOrEqual(0.5);
    }
  });

  it('cancel settles back to full screen without any fade', () => {
    const { path, ms } = M.flight(held, v, M.REST, 'plain', 0.46, B);
    for (let t = 0; t <= ms; t += 16) expect(path(t).o).toBe(1);
    expect(path(ms)).toEqual(M.REST);
  });

  it('without an origin it leaves past the right edge, fully visible, and stops once out of sight', () => {
    const out = M.offscreenCard(B, held.s);
    expect(out.x - (B.w * out.s) / 2).toBeGreaterThan(B.w / 2);
    const { path, ms } = M.flight(held, v, out, 'leave', 0.46, B);
    for (let t = 0; t < ms; t += 16) expect(path(t).o).toBe(1);
    expect(ms).toBeLessThan(M.flight(held, v, out, 'plain', 0.46, B).ms);
  });
});

describe('pageOrigin', () => {
  beforeEach(() => __resetOrigin());
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('remembers the control a click landed on (not the icon inside it)', () => {
    document.body.innerHTML = '<button id="row"><span id="icon">›</span></button><div id="page"></div>';
    document.getElementById('icon')!.click();
    expect(claimOrigin(document.getElementById('page'))).toBe(document.getElementById('row'));
  });

  it('ignores clicks inside the opening page itself and stale clicks', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    document.body.innerHTML = '<div id="page"><button id="inner">x</button></div><button id="row">r</button>';
    document.getElementById('inner')!.click();
    expect(claimOrigin(document.getElementById('page'))).toBeNull();
    document.getElementById('row')!.click();
    now += 1500;
    expect(claimOrigin(document.getElementById('page'))).toBeNull();
  });
});
