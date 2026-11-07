import { useLayoutEffect, useRef } from 'react';
import { integerPixelScale, type MascotFrameData } from '@/lib/mascot/frames';
import { bakeMascotFrame, readMascotRim } from '@/lib/mascot/bake';
import { glitchBands, hashRandom, MORPH_TIMING, morphFrame, type MorphFrame } from '@/lib/mascot/pixelMorph';

/**
 * 「原图 → 像素小人」变身动画的播放器（纯功能：给它原图和帧数据就播一遍，播完回调，不认任何 store）。
 *
 * 时间轴在 `lib/mascot/pixelMorph.ts`（故障 → 压碎 → 闪白换图 → 扫描成像）。这里只管把每一帧画出来：
 * 画布尺寸、整数倍格子与 `MarcelSprite` 用同一套算法，所以落地那一帧和之后的播放逐像素对得上。
 * 出任何画布错误都当作「动画到此为止」直接交棒，绝不让一个彩蛋把页面带崩。
 */
export interface PixelMorphCanvasProps {
  /** 已经加载好的原图（就是页面上正显示的那张）。 */
  logo: HTMLImageElement;
  data: MascotFrameData;
  /** 原图在页面上占的边长（CSS px）。 */
  size: number;
  /** 换图那一刻（闪白最亮）。 */
  onSwap: () => void;
  /** 动画播完，或画布不可用。 */
  onDone: () => void;
}

/** 原图缩到最小时占多少格（人物那 48 格再留一点余量，看起来是「缩进」小人的身体里）。 */
const LOGO_END_CELLS = 50;
/** 像素小人身体在画布里的中心（占画布的比例）：由人物外框 9..56 × 13..60 得来，见 marcel_frames.py 的 OX/OY。 */
const FIGURE_CENTER = { x: 32.5 / 64, y: 36.5 / 64 } as const;
const GHOST_RED = '#ff2e63';
const GHOST_CYAN = '#22d3ee';
const SCAN_COLOR = '#a5f3fc';
const SCAN_GLOW = '#22d3ee';

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** 原图染成单色的副本（RGB 错位用）。 */
function tintedCopy(logo: HTMLImageElement, side: number, boxPx: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = side;
  c.height = side;
  const x = c.getContext('2d');
  if (x) {
    const o = (side - boxPx) / 2;
    x.drawImage(logo, o, o, boxPx, boxPx);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, side, side);
  }
  return c;
}

interface Painter {
  paint(mf: MorphFrame, ms: number): void;
}

function makePainter(
  ctx: CanvasRenderingContext2D,
  W: number,
  scale: number,
  boxPx: number,
  logo: HTMLImageElement,
  sprite: HTMLCanvasElement,
): Painter {
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');
  if (!sctx) throw new Error('scratch canvas unavailable');
  const ghostR = tintedCopy(logo, W, boxPx, GHOST_RED);
  const ghostC = tintedCopy(logo, W, boxPx, GHOST_CYAN);
  const nw = logo.naturalWidth || logo.width || 1;
  const nh = logo.naturalHeight || logo.height || 1;

  /** 把 src 降到 n×n 再用「不平滑」放回整张画布 = 马赛克。(dx, dy, side) 是 src 在画布上的位置。 */
  const mosaic = (
    src: CanvasImageSource,
    n: number,
    dx: number,
    dy: number,
    side: number,
    bands?: ReturnType<typeof glitchBands>,
    gl = 0,
  ) => {
    scratch.width = n;
    scratch.height = n;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.clearRect(0, 0, n, n);
    sctx.drawImage(src, (dx * n) / W, (dy * n) / W, (side * n) / W, (side * n) / W);
    ctx.imageSmoothingEnabled = false;
    if (bands && gl > 0) {
      for (const b of bands) {
        ctx.drawImage(scratch, 0, b.y0 * n, n, (b.y1 - b.y0) * n, b.dx * gl * W * 0.07, b.y0 * W, W, (b.y1 - b.y0) * W);
      }
    } else {
      ctx.drawImage(scratch, 0, 0, n, n, 0, 0, W, W);
    }
  };

  return {
    paint(mf, ms) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, W);
      const seed = Math.floor(ms / 50);
      const rnd = hashRandom(seed + 7);
      const bands = mf.glitch > 0 ? glitchBands(seed) : undefined;

      if (mf.source === 'logo') {
        const side = lerp(boxPx, LOGO_END_CELLS * scale, mf.shrink);
        // 缩小时不是原地缩，而是朝小人身体的中心靠拢（人物在 64 格画布里偏右下），换图那一刻不跳位
        const x0 = lerp(W - side, W * FIGURE_CENTER.x * 2 - side, mf.shrink) / 2;
        const y0 = lerp(W - side, W * FIGURE_CENTER.y * 2 - side, mf.shrink) / 2;
        const shake = mf.glitch * W * 0.012;
        const sx = (rnd() - 0.5) * 2 * shake;
        const sy = (rnd() - 0.5) * 2 * shake;
        ctx.save();
        ctx.translate(sx, sy);
        if (mf.grid === 0) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          if (mf.glitch > 0) {
            const d = mf.glitch * W * 0.03;
            ctx.globalAlpha = 0.6 * Math.min(1, mf.glitch * 1.6);
            ctx.drawImage(ghostR, -d, 0);
            ctx.drawImage(ghostC, d, 0);
            ctx.globalAlpha = 1;
          }
          if (bands) {
            for (const b of bands) {
              ctx.drawImage(
                logo,
                0, b.y0 * nh, nw, (b.y1 - b.y0) * nh,
                x0 + b.dx * mf.glitch * W * 0.07, y0 + b.y0 * side, side, (b.y1 - b.y0) * side,
              );
            }
          } else {
            ctx.drawImage(logo, x0, y0, side, side);
          }
        } else {
          mosaic(logo, mf.grid, x0, y0, side, bands, mf.glitch);
        }
        ctx.restore();
      } else {
        const scanY = mf.scan == null ? W : Math.round(mf.scan * 64) * scale;
        if (mf.scan != null && mf.grid > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, scanY, W, W - scanY);
          ctx.clip();
          mosaic(sprite, mf.grid, 0, 0, W);
          ctx.restore();
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, scanY);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sprite, 0, 0, W, W);
        ctx.restore();
      }

      // 白闪 / 扫描线 / 扫描尾迹：只盖在已画出的人物上（source-atop），空白处不脏
      const scanY = mf.scan == null ? 0 : Math.round(mf.scan * 64) * scale;
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      if (mf.flash > 0) {
        ctx.globalAlpha = mf.flash;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, W);
        ctx.globalAlpha = 1;
      }
      if (mf.scanlines) {
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        const th = Math.max(1, Math.round(scale / 2));
        for (let y = 0; y < W; y += scale * 2) ctx.fillRect(0, y, W, th);
      }
      if (mf.scan != null) {
        const trail = scale * 6;
        const g = ctx.createLinearGradient(0, scanY - trail, 0, scanY);
        g.addColorStop(0, 'rgba(34,211,238,0)');
        g.addColorStop(1, 'rgba(165,243,252,0.5)');
        ctx.fillStyle = g;
        ctx.fillRect(0, scanY - trail, W, trail);
      }
      ctx.restore();

      // 扫描亮线本体：带辉光，画在最上面，空白处也看得见（它是「在画」的那支笔）
      if (mf.scan != null) {
        ctx.save();
        ctx.shadowColor = SCAN_GLOW;
        ctx.shadowBlur = scale * 3;
        ctx.fillStyle = SCAN_COLOR;
        ctx.fillRect(0, scanY - Math.max(1, Math.round(scale / 2)), W, Math.max(2, scale));
        ctx.restore();
      }
    },
  };
}

export default function PixelMorphCanvas({ logo, data, size, onSwap, onDone }: PixelMorphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 回调走 ref：父组件重渲染不该重启动画
  const swapRef = useRef(onSwap);
  const doneRef = useRef(onDone);
  swapRef.current = onSwap;
  doneRef.current = onDone;

  const dpr = window.devicePixelRatio || 1;
  const [cw, ch] = data.size;
  const scale = integerPixelScale(size, ch, dpr);
  const cell = scale / dpr;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    let raf = 0;
    let finished = false;
    let swapped = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      doneRef.current();
    };
    if (!canvas) {
      finish();
      return;
    }
    let painter: Painter;
    try {
      const W = cw * scale;
      canvas.width = W;
      canvas.height = ch * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      const sprite = bakeMascotFrame(data, data.states.idle[0][0], readMascotRim());
      painter = makePainter(ctx, W, scale, Math.round(size * dpr), logo, sprite);
      painter.paint(morphFrame(0), 0); // 同步画第一帧：和被盖住的原图几乎一样，换手时不跳
    } catch (err) {
      console.warn('Pixel morph unavailable, skipping animation:', err);
      finish();
      return;
    }

    let start = 0;
    const tick = (now: number) => {
      raf = 0;
      if (start === 0) start = now;
      const ms = now - start;
      try {
        if (!swapped && ms >= MORPH_TIMING.swapAt) {
          swapped = true;
          swapRef.current();
        }
        const mf = morphFrame(ms);
        painter.paint(mf, ms);
        if (mf.done) {
          finish();
          return;
        }
      } catch (err) {
        console.warn('Pixel morph failed, skipping rest of animation:', err);
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      finished = true;
      if (raf) cancelAnimationFrame(raf);
    };
    // 只在挂载时播一遍：尺寸 / 数据中途变了也不重播（重播会让变身看起来卡住）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ display: 'block', width: cw * cell, height: ch * cell, imageRendering: 'pixelated', pointerEvents: 'none' }}
    />
  );
}
