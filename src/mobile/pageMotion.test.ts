// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __pageMotionMath as M, type Box, type Card } from './pageMotion';
import { __resetOrigin, claimOrigin } from './pageOrigin';

const B: Box = { left: 0, top: 0, w: 390, h: 788 };
const ROW = { left: 12, top: 419, width: 366, height: 67 };

function gap(a: Card, b: Card): number {
  return (
    Math.abs(a.cx - a.w / 2 - (b.cx - b.w / 2)) +
    Math.abs(a.cx + a.w / 2 - (b.cx + b.w / 2)) +
    Math.abs(a.cy - a.h / 2 - (b.cy - b.h / 2)) +
    Math.abs(a.cy + a.h / 2 - (b.cy + b.h / 2))
  );
}

const ZERO: Card = { cx: 0, cy: 0, w: 0, h: 0, rl: 0, rx: 0, ry: 0, o: 0, sh: 0 };

describe('card geometry', () => {
  it('a card on a row covers exactly that row (page cropped from the top)', () => {
    const c = M.cardOn(ROW, 10, B);
    expect(c.cx).toBeCloseTo(ROW.left + ROW.width / 2);
    expect(c.cy).toBeCloseTo(ROW.top + ROW.height / 2);
    expect(c.w).toBeCloseTo(ROW.width);
    expect(c.h).toBeCloseTo(ROW.height);
    // Visible corner radius = element radius × scale.
    expect(c.rl * (c.w / B.w)).toBeCloseTo(10);
    // The clip keeps the top ROW.height / scale px of the page.
    const s = c.w / B.w;
    const bottom = Number(M.cardClip(c, B).match(/inset\(0px 0px ([\d.]+)px/)![1]);
    expect((B.h - bottom) * s).toBeCloseTo(ROW.height, 0);
  });

  it('a tall origin gets a card as wide as it, never taller than the page allows', () => {
    const c = M.cardOn({ left: 100, top: 100, width: 40, height: 400 }, 8, B);
    expect(c.w).toBeCloseTo(40);
    expect(c.h).toBeCloseTo((40 * B.h) / B.w);
  });

  it('the held card at rest is the page itself, unclipped', () => {
    const c = M.heldCard({ x: 0, y: 0, s: 1, rx: 0, ry: 0, o: 1 }, B);
    expect(c).toEqual(M.restCard(B));
    expect(M.cardClip(c, B)).toBe('inset(0px 0px 0.0px 0px round 28.0px)');
    expect(M.cardTransform(c, B)).toContain('translate3d(195.00px, 394.00px, 0)');
  });

  it('the clip does not change while the finger holds the card (no repaint)', () => {
    const clips = new Set(
      [1, 0.9, 0.8, 0.7].map((s) => M.cardClip(M.heldCard({ x: -12, y: 4, s, rx: 6, ry: -14, o: 1 }, B), B)),
    );
    expect(clips.size).toBe(1);
  });
});

describe('flights', () => {
  const held = M.heldCard({ x: -20, y: 4, s: 0.8, rx: 8, ry: -18, o: 1 }, B);
  const v: Card = { ...ZERO, cx: -0.12, cy: 0.05, w: -0.3, h: -0.6, ry: -0.04 };
  const home = M.cardOn(ROW, 10, B);

  it('flies home from exactly the held pose, at the held speed, and lands on the row', () => {
    const { path, ms } = M.flight(held, v, home, 'home', 0.42);
    expect(path(0)).toEqual(held);
    // The hand-over carries the finger's speed: compared with a flight that
    // starts still, the first step is ahead by exactly that speed.
    const still = M.flight(held, { ...ZERO }, home, 'home', 0.42).path;
    expect((path(4).cx - still(4).cx) / 4).toBeCloseTo(v.cx, 1);
    expect((path(4).w - still(4).w) / 4).toBeCloseTo(v.w, 1);
    expect(path(ms)).toEqual(home);
    expect(ms).toBeLessThan(1200);
  });

  it('never fades in mid-air: the page is fully visible until it is within ~half a row of it', () => {
    const { path, ms } = M.flight(held, v, home, 'home', 0.42);
    for (let t = 0; t <= ms; t += 8) {
      const c = path(t);
      if (gap(c, home) > 34) expect(c.o).toBe(1);
    }
    expect(path(ms).o).toBe(0);
  });

  it('tilts unwind to flat as it lands', () => {
    const { path, ms } = M.flight(held, v, home, 'home', 0.42);
    expect(Math.abs(path(ms * 0.8).ry)).toBeLessThan(1);
    expect(path(ms).ry).toBe(0);
  });

  it('growing out of the row is the mirror: visible as soon as it leaves the row', () => {
    const rest = M.restCard(B);
    const { path, ms } = M.flight(home, { ...ZERO }, rest, 'grow', 0.42);
    expect(path(0).o).toBe(0);
    for (let t = 0; t <= ms; t += 8) {
      const c = path(t);
      if (gap(c, home) > 34) expect(c.o).toBe(1);
    }
    expect(path(ms)).toEqual(rest);
  });

  it('cancel settles back to full screen without any fade', () => {
    const rest = M.restCard(B);
    const { path, ms } = M.flight(held, v, rest, 'plain', 0.42);
    for (let t = 0; t <= ms; t += 16) expect(path(t).o).toBe(1);
    expect(path(ms)).toEqual(rest);
  });

  it('without an origin it leaves past the right edge, fully visible', () => {
    const out = M.offscreenCard(B, held.w, held.h);
    expect(out.cx - out.w / 2).toBeGreaterThan(B.left + B.w);
    const { path, ms } = M.flight(held, v, out, 'plain', 0.42);
    for (let t = 0; t <= ms; t += 16) expect(path(t).o).toBe(1);
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
