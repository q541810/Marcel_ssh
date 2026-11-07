import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  integerPixelScale,
  keyFrameIndex,
  loadMascotFrames,
  MASCOT_STATE_LABEL,
  peekMascotFrames,
  type MascotFrameData,
  type MascotState,
} from '@/lib/mascot/frames';
import { prefersReducedMotion } from '@/lib/confetti';
import { createLogoBounce, type LogoBounce } from '@/lib/logoBounce';
import { bakeMascotFrame, readMascotRim } from '@/lib/mascot/bake';

/**
 * 玛瑟尔像素动画播放器（纯功能：给一个状态就播，不认任何 store）。
 *
 * - **整数倍像素**：每个格子占整数个屏幕物理像素（`integerPixelScale`），系统缩放 125% / 150% 时
 *   也不会一胖一瘦；所以实际显示尺寸会落在 `size` 附近、不一定正好等于它。
 * - **看不见就不播**：滚出视口、窗口切到后台都停表，回来接着播。
 * - **减少动态效果**：只显示该状态的关键姿势（`keyFrameIndex`），不循环。
 * - **跟主题走**：描边外那一圈外缘（帧里的 `O`）用当前主题的强边框色 `--color-edge-strong`，
 *   深色下把黑描边从深底里托出来、浅色下只是一圈淡灰；主题一换就重画，别在这里写死颜色。
 * - **戳一下**（传了 `onPoke` 才有）：按下就压扁、松手弹起，复用关于页图标那套弹簧（`logoBounce`）。
 *   只有身体那块接点击，气泡和四周透明边不挡下面的东西。
 */
export interface MarcelSpriteProps {
  state: MascotState;
  /** 目标显示高度（CSS px，对应 64×64 整张画布）。 */
  size: number;
  /** 「坐」模式：把画布往下、往右挪掉透明边，让人物描边的最底行 / 最右列正好贴住容器边。 */
  perch?: boolean;
  className?: string;
  style?: CSSProperties;
  /** 被戳了一下（松手时）。不传 = 纯展示，不接任何指针事件。 */
  onPoke?: () => void;
}

let drawFailureLogged = false;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** 设备像素比：拖到另一块屏 / 改系统缩放时会变。 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [dpr]);
  return dpr;
}

/** 主题版本号：<html> 上的变量 / 明暗标记一变就 +1，触发用新外缘色重画。 */
function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setV((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-marcel-theme'] });
    return () => mo.disconnect();
  }, []);
  return v;
}

export default memo(function MarcelSprite({ state, size, perch = false, className, style, onPoke }: MarcelSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bounceRef = useRef<LogoBounce | null>(null);
  const pressedRef = useRef(false);
  const [data, setData] = useState<MascotFrameData | null>(peekMascotFrames);
  const [onScreen, setOnScreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const reduced = useReducedMotion();
  const dpr = useDevicePixelRatio();
  const themeVersion = useThemeVersion();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (data) return;
    let alive = true;
    loadMascotFrames().then((d) => { if (alive) setData(d); }).catch((err) => {
      console.error('Failed to load mascot frames:', err);
    });
    return () => { alive = false; };
  }, [data]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const on = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // 换状态从头播
  useEffect(() => { setFrame(0); }, [state]);

  const seq = data?.states[state];
  const playing = !!seq && seq.length > 1 && !reduced && onScreen && pageVisible;
  const shownIndex = seq ? (reduced ? keyFrameIndex(state, seq.length) : Math.min(frame, seq.length - 1)) : 0;

  useEffect(() => {
    if (!playing || !seq) return;
    const timer = window.setTimeout(() => setFrame((f) => (f + 1) % seq.length), seq[Math.min(frame, seq.length - 1)][1]);
    return () => window.clearTimeout(timer);
  }, [playing, seq, frame]);

  const [cw, ch] = data?.size ?? [64, 64];
  const scale = integerPixelScale(size, ch, dpr);
  const cell = scale / dpr; // 一个格子的 CSS 尺寸

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || !seq) return;
    if (canvas.width !== cw * scale) canvas.width = cw * scale;
    if (canvas.height !== ch * scale) canvas.height = ch * scale;
    // 纯装饰：画布不可用（被禁用的 2D 上下文、测试环境的假画布……）时宁可不画，也绝不能
    // 抛错把整个 Agent 面板一起带崩
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bakeMascotFrame(data, seq[shownIndex][0], readMascotRim()), 0, 0, canvas.width, canvas.height);
    } catch (err) {
      if (!drawFailureLogged) {
        drawFailureLogged = true;
        console.warn('Mascot canvas unavailable, skipping drawing:', err);
      }
    }
  }, [data, seq, shownIndex, scale, cw, ch, themeVersion]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !onPoke) return;
    const bounce = createLogoBounce(el, prefersReducedMotion);
    bounceRef.current = bounce;
    return () => { bounce.dispose(); bounceRef.current = null; };
  }, [onPoke]);

  const perchStyle: CSSProperties = perch && data
    ? {
        marginBottom: -(ch - 1 - data.anchor.bottom) * cell,
        marginRight: -(cw - 1 - data.anchor.right) * cell,
      }
    : {};

  const canvas = (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`玛瑟尔：${MASCOT_STATE_LABEL[state]}`}
      className={onPoke ? undefined : className}
      style={{
        display: 'block', width: cw * cell, height: ch * cell, imageRendering: 'pixelated',
        pointerEvents: 'none', ...perchStyle, ...(onPoke ? null : style),
      }}
    />
  );
  if (!onPoke) return canvas;

  const a = data?.anchor;
  return (
    <div
      ref={wrapRef}
      className={`relative ${className ?? ''}`}
      style={{ pointerEvents: 'none', transformOrigin: '50% 100%', ...style }}
    >
      {canvas}
      {a && (
        <div
          aria-hidden="true"
          className="absolute cursor-pointer select-none touch-manipulation [-webkit-tap-highlight-color:transparent]"
          style={{
            pointerEvents: 'auto',
            left: a.left * cell,
            top: a.top * cell,
            width: (a.right - a.left + 1) * cell,
            height: (a.bottom - a.top + 1) * cell,
          }}
          onPointerDown={() => { pressedRef.current = true; bounceRef.current?.press(); }}
          onPointerCancel={() => { pressedRef.current = false; bounceRef.current?.release(0); }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse' && pressedRef.current) { pressedRef.current = false; bounceRef.current?.release(0); }
          }}
          onClick={() => { pressedRef.current = false; bounceRef.current?.release(1); onPoke(); }}
        />
      )}
    </div>
  );
});
