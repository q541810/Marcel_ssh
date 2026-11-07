/**
 * 礼炮彩带引擎（零依赖，单张全屏 canvas）。
 *
 * 角色：纯功能模块（不协调其他功能）。关于页解锁仪式的礼炮、以及「至尊无敌特效」
 * 打开后输入框里的每一发小礼炮，都经由 `fireConfetti` 出手 —— 想给别的地方也加礼炮，
 * 调它就行，不要再另建一张 canvas。
 *
 * 设计要点：
 * - 粒子物理（`spawnParticles` / `stepParticle`）是不碰 DOM 的纯函数，可单测；
 *   渲染层只负责把它们画出来。
 * - 画布按需创建、粒子清空即销毁，空闲时对页面零开销（没有常驻 rAF）。
 * - 「减少动态效果」在引擎入口统一拦截：任何调用方都不必记得自己判断。
 */

export const CONFETTI_COLORS = [
  '#f43f5e', // rose
  '#f59e0b', // amber
  '#facc15', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#d946ef', // fuchsia
] as const;

/** 一发礼炮。角度按屏幕坐标：-90 = 正上方，0 = 向右，180 = 向左。 */
export interface ConfettiBurst {
  /** 炮口位置（视口像素）。 */
  x: number;
  y: number;
  /** 发射方向（度）。 */
  angle: number;
  /** 扇形总张角（度），粒子在 angle ± spread/2 内随机。 */
  spread: number;
  count: number;
  /** 初速度范围（px/s）。 */
  speed?: readonly [number, number];
  /** 存活时间范围（秒）。 */
  life?: readonly [number, number];
  /** 重力（px/s²）。 */
  gravity?: number;
  /** 空气阻力系数（1/s，越大越快收速）。 */
  drag?: number;
  /** 纸片整体大小倍率。 */
  scale?: number;
  colors?: readonly string[];
  /**
   * 像素碎片：只出方块、不旋转不翻面不飘，落笔时坐标取整——像素风场景用（关于页图标变像素那一刻）。
   * 方块边长取 `6~11 × scale`，想要整数倍像素就给整数 scale 的约数，别指望引擎替你对齐格子。
   */
  pixel?: boolean;
}

type Shape = 0 | 1 | 2; // 0 方片 / 1 圆点 / 2 细条

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  /** 翻面相位：画的时候取 cos 当纵向缩放，纸片就有了翻转的立体感。 */
  flip: number;
  flipSpeed: number;
  sway: number;
  swayFreq: number;
  swayPhase: number;
  gravity: number;
  drag: number;
  age: number;
  life: number;
  color: string;
  shape: Shape;
  pixel?: boolean;
}

/** 同屏粒子上限：打字很快时也不至于越攒越多拖垮帧率。 */
const MAX_PARTICLES = 700;
/** 单帧最大步长：切走标签页再回来时别让粒子一步飞出屏幕。 */
const MAX_FRAME_DT = 1 / 30;
const LAYER_Z_INDEX = 100000;

const DEFAULTS = {
  speed: [500, 900] as const,
  life: [1.4, 2.4] as const,
  gravity: 1600,
  drag: 1.8,
  scale: 1,
};

/** 生成一发礼炮的全部粒子。`rng` 可注入，测试里用固定序列。 */
export function spawnParticles(burst: ConfettiBurst, rng: () => number = Math.random): Particle[] {
  const [vMin, vMax] = burst.speed ?? DEFAULTS.speed;
  const [lMin, lMax] = burst.life ?? DEFAULTS.life;
  const gravity = burst.gravity ?? DEFAULTS.gravity;
  const drag = burst.drag ?? DEFAULTS.drag;
  const scale = burst.scale ?? DEFAULTS.scale;
  const colors = burst.colors && burst.colors.length > 0 ? burst.colors : CONFETTI_COLORS;

  const out: Particle[] = [];
  for (let i = 0; i < burst.count; i += 1) {
    const dir = ((burst.angle + (rng() - 0.5) * burst.spread) * Math.PI) / 180;
    const speed = vMin + rng() * (vMax - vMin);
    const w = (6 + rng() * 5) * scale;
    const shapeRoll = rng();
    const shape: Shape = burst.pixel ? 0 : shapeRoll < 0.62 ? 0 : shapeRoll < 0.82 ? 1 : 2;
    const side = burst.pixel ? Math.max(2, Math.round(w)) : w;
    out.push({
      x: burst.x,
      y: burst.y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      w: burst.pixel ? side : shape === 2 ? w * 0.4 : w,
      h: burst.pixel ? side : shape === 2 ? w * 1.6 : shape === 1 ? w : w * (0.45 + rng() * 0.35),
      rot: burst.pixel ? 0 : rng() * Math.PI * 2,
      vrot: burst.pixel ? 0 : (rng() - 0.5) * 14,
      flip: burst.pixel ? 0 : rng() * Math.PI * 2,
      flipSpeed: burst.pixel ? 0 : 6 + rng() * 10,
      sway: burst.pixel ? 0 : 20 + rng() * 40,
      swayFreq: 4 + rng() * 5,
      swayPhase: rng() * Math.PI * 2,
      gravity,
      drag,
      age: 0,
      life: lMin + rng() * (lMax - lMin),
      color: colors[Math.floor(rng() * colors.length) % colors.length],
      shape,
      pixel: burst.pixel,
    });
  }
  return out;
}

/** 推进一个粒子 dt 秒；返回 false 表示寿命已尽。 */
export function stepParticle(p: Particle, dt: number): boolean {
  p.age += dt;
  if (p.age >= p.life) return false;
  const damp = Math.exp(-p.drag * dt);
  p.vx *= damp;
  p.vy = (p.vy + p.gravity * dt) * damp;
  // 下落时左右轻轻飘：纸片不是石头
  p.x += (p.vx + Math.sin(p.age * p.swayFreq + p.swayPhase) * p.sway) * dt;
  p.y += p.vy * dt;
  p.rot += p.vrot * dt;
  p.flip += p.flipSpeed * dt;
  return true;
}

/** 系统开了「减少动态效果」：礼炮这类大幅度运动一律不放。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// ───── 渲染层（模块级单例）─────

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let rafId = 0;
let lastTime = 0;
let pixelRatio = 1;

function ensureCanvas(): boolean {
  if (canvas && ctx) return true;
  if (typeof document === 'undefined' || !document.body) return false;
  const node = document.createElement('canvas');
  const context = typeof node.getContext === 'function' ? node.getContext('2d') : null;
  if (!context) return false;
  node.setAttribute('aria-hidden', 'true');
  node.style.cssText = [
    'position:fixed',
    'inset:0',
    'width:100vw',
    'height:100vh',
    'pointer-events:none',
    `z-index:${LAYER_Z_INDEX}`,
  ].join(';');
  document.body.appendChild(node);
  canvas = node;
  ctx = context;
  syncCanvasSize();
  return true;
}

function syncCanvasSize(): void {
  if (!canvas) return;
  pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(window.innerWidth * pixelRatio);
  const h = Math.round(window.innerHeight * pixelRatio);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function teardown(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  lastTime = 0;
  particles = [];
  canvas?.remove();
  canvas = null;
  ctx = null;
}

function drawParticle(c: CanvasRenderingContext2D, p: Particle): void {
  const fade = Math.min(1, (p.life - p.age) / 0.5);
  c.globalAlpha = Math.max(0, fade);
  c.fillStyle = p.color;
  if (p.pixel) {
    // 像素碎片：边缘必须落在整数坐标上，否则会糊成半透明边
    c.fillRect(Math.round(p.x - p.w / 2), Math.round(p.y - p.h / 2), p.w, p.h);
    return;
  }
  c.save();
  c.translate(p.x, p.y);
  c.rotate(p.rot);
  if (p.shape === 1) {
    c.beginPath();
    c.arc(0, 0, p.w / 2, 0, Math.PI * 2);
    c.fill();
  } else {
    c.scale(1, Math.cos(p.flip));
    c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
  }
  c.restore();
}

function frame(now: number): void {
  rafId = 0;
  if (!canvas || !ctx) return;
  const dt = lastTime === 0 ? 1 / 60 : Math.min(MAX_FRAME_DT, (now - lastTime) / 1000);
  lastTime = now;

  syncCanvasSize();
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const floor = window.innerHeight + 60;
  const alive: Particle[] = [];
  for (const p of particles) {
    // 落出屏幕下沿就不用再算了
    if (!stepParticle(p, dt) || p.y > floor) continue;
    drawParticle(ctx, p);
    alive.push(p);
  }
  ctx.globalAlpha = 1;
  particles = alive;

  if (particles.length === 0) {
    teardown();
    return;
  }
  rafId = requestAnimationFrame(frame);
}

/**
 * 放一发礼炮。减少动态效果 / 页面不可见 / 环境不支持 canvas 时静默跳过。
 * 同屏粒子超过上限时丢弃新粒子（保住帧率比多一发礼炮重要）。
 */
export function fireConfetti(burst: ConfettiBurst): void {
  if (prefersReducedMotion()) return;
  if (typeof document === 'undefined' || document.hidden) return;
  const room = MAX_PARTICLES - particles.length;
  if (room <= 0 || burst.count <= 0) return;
  if (!ensureCanvas()) return;

  const fresh = spawnParticles({ ...burst, count: Math.min(burst.count, room) });
  particles.push(...fresh);
  if (!rafId) rafId = requestAnimationFrame(frame);
}

/** 立刻清场（测试与页面卸载用）。 */
export function clearConfetti(): void {
  teardown();
}
