import { describe, expect, it } from 'vitest';
import { MascotPlayground, rubberBand, type MascotBounds } from './playground';

const BOUNDS: MascotBounds = { minX: 0, maxX: 280, maxY: 56 };
const OPTIONS = { bounds: BOUNDS, bodySize: { width: 48, height: 48 }, random: () => 0 };

function play(options: Partial<ConstructorParameters<typeof MascotPlayground>[0]> = {}) {
  return new MascotPlayground({ ...OPTIONS, ...options });
}

function settle(engine: MascotPlayground): void {
  for (let i = 0; i < 1200; i += 1) {
    engine.step(1 / 120);
    if (engine.snapshot.mode === 'idle') return;
  }
  throw new Error(`运动没有收束：${JSON.stringify(engine.snapshot)}`);
}

describe('玛瑟尔活动区边界', () => {
  it('初始仍坐右边，短面板退化成一个固定落点', () => {
    expect(play().snapshot.pose.x).toBe(280);
    const tiny = play({ bounds: { minX: 0, maxX: -100, maxY: -10 } });
    expect(tiny.snapshot.pose).toMatchObject({ x: 0, lift: 0 });
  });

  it('抓住时保留偏移，不吸到指针中心；拖动与点击分开', () => {
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 100);
    engine.pointerMove(1, { x: 238, y: 27 }, 116);
    engine.pointerMove(1, { x: 200, y: 27 }, 132);
    expect(engine.snapshot.pose.grabbed).toBe(true);
    // 身体保留抓取点，直接跟手；只有内层像素偏移用来表达被拽着。
    expect(engine.snapshot.pose.x).toBeGreaterThan(200);
    expect(engine.snapshot.pose.x).toBeLessThan(210);
    expect(engine.snapshot.pose.lift).toBe(18);
    // 拉伸由手速算出，要等一帧物理才落到姿态上。
    engine.step(1 / 60);
    expect(engine.snapshot.pose.scaleY).toBeGreaterThan(1);
    expect(engine.snapshot.pose.facing).toBe(-1);
    engine.pointerMove(1, { x: 300, y: 30 }, 148);
    expect(engine.snapshot.pose.facing).toBe(1);
    // 倾斜从当前朝向缓动过去，给几帧就会翻到新方向；往右拖，身体往左偏。
    for (let i = 0; i < 8; i += 1) engine.step(1 / 60);
    expect(engine.snapshot.pose.rotation).toBeLessThan(0);
    expect(engine.snapshot.pose.scaleX).toBeLessThan(1);
    expect(engine.pointerUp(1, 160)).toBe(true);

    const tap = play();
    tap.pointerDown(1, { x: 273, y: 7 }, 100);
    tap.pointerMove(1, { x: 273.5, y: 8 }, 110);
    expect(tap.pointerUp(1, 120)).toBe(false);
    expect(tap.snapshot.mode).toBe('idle');
  });

  it('手停住后姿态收回，但身体不擅自从手下面滑走', () => {
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: 210, y: 20 }, 24);
    const x = engine.snapshot.pose.x;
    expect(x).toBe(217);
    expect(engine.snapshot.pose.offsetX).toBe(0);
    engine.step(1 / 60);
    expect(engine.snapshot.pose.offsetX).toBeGreaterThan(0);
    const offset = engine.snapshot.pose.offsetX;
    for (let i = 0; i < 20; i += 1) engine.step(0.02);
    expect(engine.snapshot.pose.x).toBe(x);
    expect(engine.snapshot.pose.offsetX).toBeLessThan(offset);
    expect(Math.abs(engine.snapshot.pose.rotation)).toBeLessThan(0.1);
  });

  it('橡皮筋越拖越难、有限，松手回到范围内', () => {
    expect(rubberBand(-20, 0, 280, 16)).toBeLessThan(0);
    expect(rubberBand(-20, 0, 280, 16)).toBeGreaterThan(-16);
    expect(rubberBand(-2000, 0, 280, 16)).toBeGreaterThanOrEqual(-16);
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: -500, y: 300 }, 20);
    expect(engine.snapshot.pose.x).toBeGreaterThanOrEqual(-45);
    expect(engine.snapshot.pose.lift).toBeLessThanOrEqual(56 + 34);
    engine.pointerUp(1, 30);
    settle(engine);
    expect(engine.snapshot.pose).toMatchObject({ x: 0, lift: 0 });
  });

  it('猛甩最多顺势补 30px，并在 260ms 内放下', () => {
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: 250, y: 20 }, 10);
    engine.pointerMove(1, { x: 60, y: 24 }, 30);
    const startX = engine.snapshot.pose.x;
    engine.pointerUp(1, 40);
    expect(Math.abs(engine.snapshot.pose.x - startX)).toBeLessThan(160);
    engine.step(0.27);
    expect(engine.snapshot.pose.lift).toBe(0);
    expect(engine.snapshot.pose.x).toBeGreaterThanOrEqual(startX - 30);
    expect(engine.snapshot.pose.x).toBeLessThanOrEqual(startX + 30);
    settle(engine);
    expect(engine.snapshot.pose.lift).toBe(0);
  });

  it('左右高速抛掷、抛到顶、连续模拟都不越界', () => {
    for (const target of [-1000, 1400]) {
      const engine = play();
      engine.pointerDown(1, { x: 273, y: 7 }, 0);
      engine.pointerMove(1, { x: 273, y: 27 }, 10);
      engine.pointerMove(1, { x: target, y: -900 }, 30);
      engine.pointerUp(1, 40);
      expect(engine.snapshot.pose.x).toBeGreaterThanOrEqual(0);
      expect(engine.snapshot.pose.x).toBeLessThanOrEqual(280);
      for (let i = 0; i < 800; i += 1) {
        engine.step(1 / 120);
        const { pose } = engine.snapshot;
        expect(pose.x).toBeGreaterThanOrEqual(0);
        expect(pose.x).toBeLessThanOrEqual(280);
        expect(pose.lift).toBeGreaterThanOrEqual(0);
        expect(pose.lift).toBeLessThanOrEqual(56);
      }
      expect(engine.snapshot.mode).toBe('idle');
    }
  });

  it('飞行途中可抓住，从呈现位置继续而不是回起点', () => {
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: 200, y: 20 }, 30);
    engine.pointerUp(1, 40);
    engine.step(0.05);
    const before = engine.snapshot.pose;
    expect(before.lift).toBeGreaterThan(0);
    engine.pointerDown(2, { x: before.x + 20, y: before.lift + 10 }, 100);
    expect(engine.snapshot.pose).toMatchObject({ x: before.x, lift: before.lift, grabbed: true });
    engine.pointerMove(2, { x: before.x - 50, y: before.lift + 10 }, 120);
    // 抓住放下途中的它，仍从当前呈现位置继续跟手。
    expect(engine.snapshot.pose.x).toBeLessThan(before.x - 40);
    engine.pointerCancel(2, 130);
    expect(engine.snapshot.pose.grabbed).toBe(false);
  });

  it('窗口缩小时位置与运动都被收进新边界', () => {
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: 200, y: -100 }, 20);
    engine.pointerUp(1, 30);
    engine.resize({ minX: 20, maxX: 80, maxY: 16 });
    expect(engine.snapshot.pose.x).toBeLessThanOrEqual(80);
    expect(engine.snapshot.pose.lift).toBeLessThanOrEqual(16);
    settle(engine);
    expect(engine.snapshot.pose.x).toBeGreaterThanOrEqual(20);
  });
});

describe('待机蹦哒与生命周期', () => {
  it('到点偶发小跳，忙/睡觉/拖拽时不自发', () => {
    const engine = play();
    // 不满足条件时完全不动。
    expect(engine.wander(1000, false)).toBe(false);
    expect(engine.wander(1000, true)).toBe(false); // 只排期
    // 排期之后在足够晚的时刻一定会起跳，且不是每 2 秒都跳。
    let jumped = false;
    for (let t = 2000; t <= 60000 && !jumped; t += 500) jumped = engine.wander(t, true);
    expect(jumped).toBe(true);
    expect(engine.snapshot.mode).toBe('hopping');
    expect(engine.snapshot.pose.lift).toBe(0);
    expect(engine.wander(61000, false)).toBe(false);
    engine.pointerDown(1, { x: 280, y: 10 }, 71000);
    expect(engine.snapshot.mode).toBe('dragging');
  });

  it('减少动态效果可手动移动，但不弹、不扔、不自动蹦哒', () => {
    const engine = play({ reducedMotion: true });
    expect(engine.wander(100000, true)).toBe(false);
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: -200, y: 900 }, 30);
    // 减少动态效果：不加倾斜、不拉伸，直接跟手。
    expect(engine.snapshot.pose).toMatchObject({ x: 0, lift: 56, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(engine.pointerUp(1, 40)).toBe(true);
    expect(engine.snapshot.mode).toBe('returning');
    settle(engine);
    expect(engine.snapshot.mode).toBe('idle');
  });

  it('页面隐藏时收住手势、不补一发抛掷，回来后位置仍合法', () => {
    const engine = play();
    engine.pointerDown(1, { x: 273, y: 7 }, 0);
    engine.pointerMove(1, { x: 220, y: 30 }, 20);
    engine.setEnabled(false, 30);
    expect(engine.snapshot.pose.grabbed).toBe(false);
    expect(engine.wander(100000, true)).toBe(false);
    const frozen = engine.snapshot;
    engine.step(1);
    expect(engine.snapshot).toEqual(frozen);
    engine.setEnabled(true, 100000);
    settle(engine);
    expect(engine.snapshot.pose.x).toBeGreaterThanOrEqual(0);
  });

  it('取消与第二根手指不会误触发另一个手势', () => {
    const engine = play();
    expect(engine.pointerDown(1, { x: 280, y: 10 }, 0)).toBe(true);
    expect(engine.pointerDown(2, { x: 200, y: 10 }, 1)).toBe(false);
    expect(engine.pointerMove(2, { x: 10, y: 10 }, 10)).toBe(false);
    engine.pointerCancel(1, 20);
    expect(engine.snapshot.mode).toBe('returning');
    expect(engine.pointerUp(1, 30)).toBe(false);
  });
});
