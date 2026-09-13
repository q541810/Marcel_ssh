import { describe, expect, it } from 'vitest';
import { formatMb, updatePercent } from './updateProgress';

describe('updatePercent', () => {
  it('常规换算并四舍五入', () => {
    expect(updatePercent(0, 100)).toBe(0);
    expect(updatePercent(50, 100)).toBe(50);
    expect(updatePercent(1, 3)).toBe(33);
    expect(updatePercent(2, 3)).toBe(67);
    expect(updatePercent(100, 100)).toBe(100);
    expect(updatePercent(15 * 1024 * 1024, 30 * 1024 * 1024)).toBe(50);
  });

  it('total 未知/为 0/非法 → 0%，不出现 NaN', () => {
    expect(updatePercent(4096, 0)).toBe(0);
    expect(updatePercent(4096, -1)).toBe(0);
    expect(updatePercent(Number.NaN, 100)).toBe(0);
    expect(updatePercent(100, Number.NaN)).toBe(0);
    expect(updatePercent(100, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('超过总量封顶 100%（避免进度条溢出容器）', () => {
    expect(updatePercent(200, 100)).toBe(100);
    expect(updatePercent(40 * 1024 * 1024, 30 * 1024 * 1024)).toBe(100);
  });
});

describe('formatMb', () => {
  it('保留一位小数，非法值归零', () => {
    expect(formatMb(1024 * 1024)).toBe('1.0');
    expect(formatMb(15 * 1024 * 1024)).toBe('15.0');
    expect(formatMb(0)).toBe('0.0');
    expect(formatMb(Number.NaN)).toBe('0.0');
  });
});
