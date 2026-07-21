import { describe, it, expect } from 'vitest';
import {
  fitScale,
  zoomAt,
  clampPan,
  doubleTapTargetScale,
  pinchOf,
} from './gestures';

describe('fitScale', () => {
  it('scales large image down to fit container', () => {
    // 2000x1000 image in 400x800 container → limited by width: 400/2000 = 0.2
    expect(fitScale(2000, 1000, 400, 800)).toBe(0.2);
  });

  it('does not scale small image up beyond 1', () => {
    expect(fitScale(100, 100, 400, 800)).toBe(1);
  });

  it('swaps effective dimensions when rotated 90 or 270 degrees', () => {
    // rotated: effective 1000x2000 in 400x800 → min(400/1000, 800/2000) = 0.4
    expect(fitScale(2000, 1000, 400, 800, 90)).toBe(0.4);
    expect(fitScale(2000, 1000, 400, 800, 270)).toBe(0.4);
    expect(fitScale(2000, 1000, 400, 800, 180)).toBe(0.2);
  });

  it('returns 1 for degenerate sizes', () => {
    expect(fitScale(0, 100, 400, 800)).toBe(1);
    expect(fitScale(100, 100, 0, 800)).toBe(1);
  });
});

describe('zoomAt', () => {
  it('keeps the anchor point fixed while zooming', () => {
    // View at scale 1, no translation. Anchor at (100, 50) relative to container center.
    const next = zoomAt(
      { scale: 1, translateX: 0, translateY: 0 },
      { anchorX: 100, anchorY: 50, factor: 2, minScale: 0.5, maxScale: 10 },
    );
    // Point under anchor before: (100 - 0) / 1 = 100 in image space.
    // After: 100*2 + tx must equal 100 → tx = -100. Same for y → ty = -50.
    expect(next.scale).toBe(2);
    expect(next.translateX).toBe(-100);
    expect(next.translateY).toBe(-50);
  });

  it('composes with existing translation', () => {
    const next = zoomAt(
      { scale: 2, translateX: -100, translateY: -50 },
      { anchorX: 100, anchorY: 50, factor: 2, minScale: 0.5, maxScale: 10 },
    );
    // Image point under anchor: (100 - (-100)) / 2 = 100 → after: 100*4 + tx = 100 → tx = -300
    expect(next.scale).toBe(4);
    expect(next.translateX).toBe(-300);
    expect(next.translateY).toBe(-150);
  });

  it('clamps to max and min scale', () => {
    const capped = zoomAt(
      { scale: 8, translateX: 0, translateY: 0 },
      { anchorX: 0, anchorY: 0, factor: 3, minScale: 0.5, maxScale: 10 },
    );
    expect(capped.scale).toBe(10);
    const floored = zoomAt(
      { scale: 1, translateX: 0, translateY: 0 },
      { anchorX: 0, anchorY: 0, factor: 0.1, minScale: 0.5, maxScale: 10 },
    );
    expect(floored.scale).toBe(0.5);
  });

  it('returns the same view when factor makes no change', () => {
    const view = { scale: 10, translateX: -30, translateY: 20 };
    const next = zoomAt(view, {
      anchorX: 50,
      anchorY: 50,
      factor: 2,
      minScale: 0.5,
      maxScale: 10,
    });
    expect(next).toEqual(view);
  });
});

describe('clampPan', () => {
  it('centers content smaller than container (no free panning)', () => {
    // 200x100 content at scale 1 in 400x800 container → smaller both axes → snap to 0
    expect(clampPan(50, -30, 200, 100, 400, 800, 1)).toEqual({ x: 0, y: 0 });
  });

  it('limits pan so content edge cannot pass container edge', () => {
    // 400x800 content at scale 2 → 800x1600 in 400x800 → max |x| = (800-400)/2 = 200, |y| = 400
    expect(clampPan(500, -900, 400, 800, 400, 800, 2)).toEqual({
      x: 200,
      y: -400,
    });
    expect(clampPan(100, 300, 400, 800, 400, 800, 2)).toEqual({
      x: 100,
      y: 300,
    });
  });

  it('clamps axes independently', () => {
    // scaled 800x400 in 400x800: x overflows (max 200), y smaller (snap 0)
    expect(clampPan(500, 100, 400, 200, 400, 800, 2)).toEqual({ x: 200, y: 0 });
  });
});

describe('doubleTapTargetScale', () => {
  it('zooms in to the zoomed scale when at fit scale', () => {
    expect(doubleTapTargetScale(0.5, 0.5, 2.5)).toBe(2.5);
  });

  it('returns to fit scale when already zoomed in', () => {
    expect(doubleTapTargetScale(2.5, 0.5, 2.5)).toBe(0.5);
    expect(doubleTapTargetScale(1.2, 0.5, 2.5)).toBe(0.5);
  });

  it('treats scales within epsilon of fit as at-fit', () => {
    expect(doubleTapTargetScale(0.5005, 0.5, 2.5)).toBe(2.5);
  });
});

describe('pinchOf', () => {
  it('computes distance and midpoint of two touches', () => {
    const p = pinchOf({ x: 0, y: 0 }, { x: 30, y: 40 });
    expect(p.distance).toBe(50);
    expect(p.centerX).toBe(15);
    expect(p.centerY).toBe(20);
  });
});
