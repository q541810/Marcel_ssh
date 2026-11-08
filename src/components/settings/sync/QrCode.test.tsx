// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QrCode } from './QrCode';
import { buildQrMatrix, MIN_MODULE_PX, qrRenderPlan, QUIET_ZONE, scaledPath } from './qrMatrix';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 把一条 path 解析回矩阵，用来验"画出来的格子确实落在该落的地方"。 */
function parsePath(path: string) {
  const cells = new Set<string>();
  const re = /M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    const x0 = Number(m[1]);
    const y0 = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) cells.add(`${x},${y}`);
    }
  }
  return cells;
}

describe('buildQrMatrix', () => {
  it('尺寸 = 17 + 4×版本号，四周各留 4 个模块静区', () => {
    const matrix = buildQrMatrix('MSYNC1-hello')!;
    expect(matrix).not.toBeNull();
    expect((matrix.moduleCount - 17) % 4).toBe(0);
    expect(matrix.size).toBe(matrix.moduleCount + QUIET_ZONE * 2);
    expect(matrix.path.startsWith('M')).toBe(true);
  });

  it('同步码这种几百字符的内容能编码；超过二维码容量时返回 null 而不是抛错', () => {
    expect(buildQrMatrix('MSYNC1-' + 'A'.repeat(600))).not.toBeNull();
    expect(buildQrMatrix('x'.repeat(5000))).toBeNull();
  });

  it('相同内容得到相同矩阵（可重复）', () => {
    expect(buildQrMatrix('MSYNC1-abc')).toEqual(buildQrMatrix('MSYNC1-abc'));
  });

  it('静区是干净的：所有模块都在 [4, size-4) 之内，外圈什么都没有', () => {
    const matrix = buildQrMatrix('MSYNC1-abc')!;
    const cells = parsePath(matrix.path);
    expect(cells.size).toBeGreaterThan(0);
    for (const key of cells) {
      const [x, y] = key.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(x).toBeLessThan(matrix.size - QUIET_ZONE);
      expect(y).toBeLessThan(matrix.size - QUIET_ZONE);
    }
  });
});

describe('scaledPath', () => {
  it('按整数倍放大后，每个格子仍然精确覆盖 k×k 个像素，没有浮点坐标', () => {
    const matrix = buildQrMatrix('MSYNC1-scale')!;
    const scaled = scaledPath(matrix, 4);
    expect(scaled).not.toMatch(/\d+\.\d/);
    // 每个 run 的宽度与高度都必须是 k 的整数倍
    const re = /M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g;
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(scaled)) !== null) {
      seen += 1;
      expect(Number(m[1]) % 4).toBe(0);
      expect(Number(m[2]) % 4).toBe(0);
      expect(Number(m[3]) % 4).toBe(0);
      expect(Number(m[4])).toBe(4);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('k=1 时原样返回（短码单像素也有用）', () => {
    const matrix = buildQrMatrix('MSYNC1-one')!;
    expect(scaledPath(matrix, 1)).toBe(matrix.path);
  });
});

describe('qrRenderPlan', () => {
  it('宽度足够时按可用宽度取整，且换算回 CSS 尺寸后每格仍是整数设备像素', () => {
    const matrix = buildQrMatrix('MSYNC1-hello')!;
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const plan = qrRenderPlan(matrix, 600, dpr);
      // modulePx × size / dpr = cssSize，反过来 CSS 尺寸 × dpr 必须回到整数
      expect((plan.cssSize * dpr) % 1).toBeLessThan(1e-9);
      expect(Math.round(plan.cssSize * dpr)).toBe(matrix.size * plan.modulePx);
      expect(plan.modulePx).toBeGreaterThanOrEqual(MIN_MODULE_PX);
    }
  });

  it('可用宽度不够时 fits 为 false（modulePx 仍不低于下限，但调用方不该画它）', () => {
    const matrix = buildQrMatrix('MSYNC1-hello')!;
    const plan = qrRenderPlan(matrix, 10, 1);
    expect(plan.modulePx).toBe(MIN_MODULE_PX);
    expect(plan.fits).toBe(false);
    // 给够宽度就是 fits
    expect(qrRenderPlan(matrix, matrix.size * MIN_MODULE_PX, 1).fits).toBe(true);
  });

  it('非法 dpr 退回 1，不产生 NaN', () => {
    const matrix = buildQrMatrix('MSYNC1-hello')!;
    const plan = qrRenderPlan(matrix, 400, 0);
    expect(Number.isFinite(plan.cssSize)).toBe(true);
    expect(plan.modulePx).toBeGreaterThanOrEqual(MIN_MODULE_PX);
  });
});

describe('QrCode', () => {
  let root: Root;
  let container: HTMLDivElement;
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mount(text: string, maxSize: number) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<QrCode text={text} maxSize={maxSize} label="同步码二维码" />));
    return container.querySelector('svg')!;
  }

  it('永远白底黑块（不随深浅色主题变），带可读的无障碍名', () => {
    const svg = mount('MSYNC1-hello', 400);
    expect(svg.getAttribute('aria-label')).toBe('同步码二维码');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#000000');
  });

  it('不用圆角：圆角会把 4 个模块的静区啃掉，定位图案就不好找了', () => {
    const svg = mount('MSYNC1-hello', 400);
    expect(svg.getAttribute('class') ?? '').not.toContain('rounded');
  });

  it('viewBox 是设备像素坐标系，格子边界全在整数上', () => {
    const svg = mount('MSYNC1-hello', 400);
    const matrix = buildQrMatrix('MSYNC1-hello')!;
    const [vbX, vbY, vbW] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    expect([vbX, vbY]).toEqual([0, 0]);
    // viewBox 宽度必须是模块数的整数倍，倍数就是每格的设备像素数
    expect(vbW % matrix.size).toBe(0);
    expect(vbW / matrix.size).toBeGreaterThanOrEqual(MIN_MODULE_PX);
  });

  it('容器给得很小时什么都不画：扫不出来的码比不显示更糟', () => {
    mount('MSYNC1-hello', 20);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('内容太长编不进去：什么都不渲染', () => {
    mount('x'.repeat(5000), 400);
    expect(container.querySelector('svg')).toBeNull();
  });
});
