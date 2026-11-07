// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfetti, fireConfetti, spawnParticles, stepParticle } from "./confetti";

/** 可复现的伪随机序列。 */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

afterEach(() => {
  clearConfetti();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("spawnParticles", () => {
  it("makes exactly `count` particles at the muzzle", () => {
    const ps = spawnParticles({ x: 10, y: 20, angle: -90, spread: 60, count: 25 }, seeded());
    expect(ps).toHaveLength(25);
    expect(ps.every((p) => p.x === 10 && p.y === 20)).toBe(true);
  });

  it("keeps every launch direction inside the cone", () => {
    const spread = 40;
    const ps = spawnParticles({ x: 0, y: 0, angle: -90, spread, count: 200, speed: [500, 500] }, seeded());
    for (const p of ps) {
      const deg = (Math.atan2(p.vy, p.vx) * 180) / Math.PI;
      expect(deg).toBeGreaterThanOrEqual(-90 - spread / 2 - 1e-6);
      expect(deg).toBeLessThanOrEqual(-90 + spread / 2 + 1e-6);
    }
  });

  it("respects the speed and life ranges", () => {
    const ps = spawnParticles(
      { x: 0, y: 0, angle: 0, spread: 10, count: 100, speed: [300, 400], life: [1, 2] },
      seeded(),
    );
    for (const p of ps) {
      const speed = Math.hypot(p.vx, p.vy);
      expect(speed).toBeGreaterThanOrEqual(300 - 1e-6);
      expect(speed).toBeLessThanOrEqual(400 + 1e-6);
      expect(p.life).toBeGreaterThanOrEqual(1);
      expect(p.life).toBeLessThanOrEqual(2);
    }
  });

  it("only uses the colors it was given", () => {
    const ps = spawnParticles({ x: 0, y: 0, angle: 0, spread: 0, count: 50, colors: ["#111", "#222"] }, seeded());
    expect(ps.every((p) => p.color === "#111" || p.color === "#222")).toBe(true);
  });
});

describe("spawnParticles 像素碎片模式", () => {
  it("只出不旋转、不翻面、不飘的整数边长正方形，颜色取自给定色板", () => {
    const colors = ["#111111", "#eeeeee"];
    const ps = spawnParticles({ x: 0, y: 0, angle: -90, spread: 360, count: 120, pixel: true, scale: 0.8, colors }, seeded());
    for (const p of ps) {
      expect(p.shape).toBe(0);
      expect(p.w).toBe(p.h);
      expect(Number.isInteger(p.w)).toBe(true);
      expect(p.w).toBeGreaterThanOrEqual(2);
      expect(p.rot).toBe(0);
      expect(p.vrot).toBe(0);
      expect(p.flipSpeed).toBe(0);
      expect(p.sway).toBe(0);
      expect(colors).toContain(p.color);
    }
  });

  it("不开 pixel 时行为不变（仍会出圆点和细条）", () => {
    const ps = spawnParticles({ x: 0, y: 0, angle: -90, spread: 90, count: 300 }, seeded());
    expect(new Set(ps.map((p) => p.shape)).size).toBe(3);
  });
});

describe("stepParticle", () => {
  it("pulls a particle downward over time (screen y grows)", () => {
    const [p] = spawnParticles(
      { x: 0, y: 0, angle: -90, spread: 0, count: 1, speed: [0, 0], gravity: 1000, drag: 0 },
      seeded(),
    );
    for (let i = 0; i < 30; i += 1) stepParticle(p, 1 / 60);
    expect(p.vy).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
  });

  it("slows a particle down with drag", () => {
    const [p] = spawnParticles(
      { x: 0, y: 0, angle: 0, spread: 0, count: 1, speed: [800, 800], gravity: 0, drag: 3 },
      seeded(),
    );
    stepParticle(p, 0.5);
    expect(p.vx).toBeLessThan(800 * 0.3);
  });

  it("reports death once the lifetime is used up", () => {
    const [p] = spawnParticles({ x: 0, y: 0, angle: 0, spread: 0, count: 1, life: [1, 1] }, seeded());
    expect(stepParticle(p, 0.5)).toBe(true);
    expect(stepParticle(p, 0.6)).toBe(false);
  });
});

describe("fireConfetti", () => {
  beforeEach(() => {
    // jsdom 没有 canvas 2d：给一个够用的桩
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => vi.restoreAllMocks());

  it("mounts a pointer-transparent canvas and tears it down on clear", () => {
    fireConfetti({ x: 5, y: 5, angle: -90, spread: 30, count: 5 });
    const canvas = document.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.style.pointerEvents).toBe("none");
    clearConfetti();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("does nothing at all when the system asks for reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query }));
    fireConfetti({ x: 5, y: 5, angle: -90, spread: 30, count: 5 });
    expect(document.querySelector("canvas")).toBeNull();
  });
});
