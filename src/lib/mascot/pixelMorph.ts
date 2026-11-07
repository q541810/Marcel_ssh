/**
 * 关于页图标「戳一下变像素」的时间轴（纯函数，不碰 DOM，可单测）。
 *
 * 一共 1.26 秒，四拍：
 *   ① 0–340ms   故障：原图 RGB 错位、横向切片抖动，越抖越凶
 *   ② 340–720   压碎：原图被一级一级降分辨率（112 → 12 格），整体收缩、盖上扫描线
 *   ③ 720–880   闪白：人物剪影整块亮起，在最亮的 760ms 偷偷换成像素小人（粗块 8 格）
 *   ④ 760–1260  成像：一道扫描线从上扫到下，线以上是清晰像素，线以下是还在变细的马赛克
 * 播放器每帧问 `morphFrame(t)`「这一刻该画什么」，自己只管画。
 */

export const MORPH_TIMING = {
  glitchEnd: 340,
  crunchEnd: 720,
  flashStart: 720,
  /** 换图那一刻（闪白最亮），礼炮碎片也在这时炸开。 */
  swapAt: 760,
  flashEnd: 880,
  doneAt: 1260,
} as const;

export const MORPH_TOTAL_MS = MORPH_TIMING.doneAt;

/** 压碎阶段的网格边长（格数）：由细到粗。0 = 不降采样。 */
const CRUNCH_GRIDS = [112, 72, 48, 32, 20, 12] as const;
/** 成像阶段，扫描线以下的马赛克网格：由粗到细，最后一级之后就是满分辨率 64 格。 */
const RESOLVE_GRIDS = [8, 12, 16, 24, 32, 48] as const;

export interface MorphFrame {
  /** 画哪一张图。 */
  source: 'logo' | 'sprite';
  /** 马赛克网格边长（格）；0 = 原样不降采样。 */
  grid: number;
  /** 原图缩向像素小人占位的程度：0 = 原尺寸，1 = 和小人一样大。 */
  shrink: number;
  /** 故障强度 0–1（RGB 错位、切片位移）。 */
  glitch: number;
  /** 白闪强度 0–1（只盖在人物上，不盖空白处）。 */
  flash: number;
  /** 扫描线位置 0–1（自上而下）；null = 没有扫描线。 */
  scan: number | null;
  scanlines: boolean;
  done: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeIn = (x: number) => x * x;
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));

function stepIndex(progress: number, count: number): number {
  return Math.min(count - 1, Math.floor(clamp01(progress) * count));
}

function flashAt(t: number): number {
  const { flashStart, swapAt, flashEnd } = MORPH_TIMING;
  if (t < flashStart || t >= flashEnd) return 0;
  return t < swapAt ? easeIn((t - flashStart) / (swapAt - flashStart)) : 1 - easeOut((t - swapAt) / (flashEnd - swapAt));
}

export function morphFrame(t: number): MorphFrame {
  const { glitchEnd, crunchEnd, swapAt, doneAt } = MORPH_TIMING;
  const flash = flashAt(t);
  if (t < glitchEnd) {
    return { source: 'logo', grid: 0, shrink: 0, glitch: easeIn(clamp01(t / glitchEnd)), flash: 0, scan: null, scanlines: false, done: false };
  }
  if (t < swapAt) {
    const p = (t - glitchEnd) / (crunchEnd - glitchEnd);
    // 压碎阶段结束后（720–760）停在最粗一级，等闪白最亮时换图
    const grid = CRUNCH_GRIDS[stepIndex(p, CRUNCH_GRIDS.length)];
    return { source: 'logo', grid, shrink: easeInOut(clamp01(p)), glitch: 0.35 * (1 - clamp01(p)), flash, scan: null, scanlines: true, done: false };
  }
  if (t < doneAt) {
    const p = (t - swapAt) / (doneAt - swapAt);
    // 起步别太慢：纯 easeInOut 会让第一道扫描线之前的粗色块停留过久，掺一半线性
    const scan = 0.5 * (easeInOut(p) + p);
    return { source: 'sprite', grid: RESOLVE_GRIDS[stepIndex(scan, RESOLVE_GRIDS.length)], shrink: 1, glitch: 0, flash, scan, scanlines: true, done: false };
  }
  return { source: 'sprite', grid: 0, shrink: 1, glitch: 0, flash: 0, scan: null, scanlines: false, done: true };
}

export interface GlitchBand {
  /** 切片在图上的纵向范围 0–1。 */
  y0: number;
  y1: number;
  /** 横向位移，−1…1（乘上强度和画布尺寸才是像素）。 */
  dx: number;
}

/** 小而稳定的哈希随机数：同一个 seed 永远给同一串，故障画面不会每次重绘都不一样。 */
export function hashRandom(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 一帧故障的横向切片：把图从上到下随机切成若干条，只有一部分条会被推歪。 */
export function glitchBands(seed: number, count = 9): GlitchBand[] {
  const rnd = hashRandom(seed);
  const cuts = Array.from({ length: count - 1 }, () => rnd()).sort((a, b) => a - b);
  const edges = [0, ...cuts, 1];
  return edges.slice(0, -1).map((y0, i) => ({
    y0,
    y1: edges[i + 1],
    dx: rnd() < 0.45 ? (rnd() - 0.5) * 2 : 0,
  }));
}
