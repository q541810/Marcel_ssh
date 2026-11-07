import { describe, expect, it } from 'vitest';
import { glitchBands, hashRandom, MORPH_TIMING, MORPH_TOTAL_MS, morphFrame } from './pixelMorph';

describe('morphFrame 时间轴', () => {
  it('开头是原图（不降采样、没闪白），结尾是满分辨率像素小人', () => {
    const first = morphFrame(0);
    expect(first).toMatchObject({ source: 'logo', grid: 0, shrink: 0, flash: 0, scan: null, done: false });
    const last = morphFrame(MORPH_TOTAL_MS);
    expect(last).toMatchObject({ source: 'sprite', grid: 0, flash: 0, scan: null, done: true });
    expect(morphFrame(MORPH_TOTAL_MS + 5000).done).toBe(true);
  });

  it('只在闪白最亮的那一刻换图：之前画原图，之后画像素小人', () => {
    expect(morphFrame(MORPH_TIMING.swapAt - 1).source).toBe('logo');
    expect(morphFrame(MORPH_TIMING.swapAt).source).toBe('sprite');
    expect(morphFrame(MORPH_TIMING.swapAt - 1).flash).toBeGreaterThan(0.9);
    expect(morphFrame(MORPH_TIMING.swapAt).flash).toBeGreaterThan(0.9);
  });

  it('压碎阶段网格只会越来越粗、成像阶段扫描线与网格只会越来越细 / 越靠下', () => {
    let prevGrid = Infinity;
    for (let t = MORPH_TIMING.glitchEnd; t < MORPH_TIMING.swapAt; t += 5) {
      const f = morphFrame(t);
      expect(f.grid).toBeLessThanOrEqual(prevGrid);
      prevGrid = f.grid;
    }
    let prevScan = -1;
    let prevFine = 0;
    for (let t = MORPH_TIMING.swapAt; t < MORPH_TOTAL_MS; t += 5) {
      const f = morphFrame(t);
      expect(f.scan).not.toBeNull();
      expect(f.scan!).toBeGreaterThanOrEqual(prevScan);
      expect(f.grid).toBeGreaterThanOrEqual(prevFine);
      prevScan = f.scan!;
      prevFine = f.grid;
    }
    expect(prevScan).toBeGreaterThan(0.95);
  });

  it('各通道取值都在合法范围内（canvas 里不会出现负尺寸 / 超 1 的透明度）', () => {
    for (let t = 0; t <= MORPH_TOTAL_MS + 20; t += 3) {
      const f = morphFrame(t);
      for (const v of [f.shrink, f.glitch, f.flash]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      if (f.scan != null) {
        expect(f.scan).toBeGreaterThanOrEqual(0);
        expect(f.scan).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('glitchBands', () => {
  it('同一个 seed 永远切出同样的条，换 seed 就变（重绘同一帧不会闪）', () => {
    expect(glitchBands(3)).toEqual(glitchBands(3));
    expect(glitchBands(3)).not.toEqual(glitchBands(4));
  });

  it('条带首尾相接、盖满整张图，位移在 −1…1', () => {
    const bands = glitchBands(11, 9);
    expect(bands).toHaveLength(9);
    expect(bands[0].y0).toBe(0);
    expect(bands[bands.length - 1].y1).toBe(1);
    bands.forEach((b, i) => {
      expect(b.y1).toBeGreaterThanOrEqual(b.y0);
      if (i > 0) expect(b.y0).toBe(bands[i - 1].y1);
      expect(Math.abs(b.dx)).toBeLessThanOrEqual(1);
    });
  });

  it('hashRandom 落在 [0,1)', () => {
    const r = hashRandom(5);
    for (let i = 0; i < 200; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
