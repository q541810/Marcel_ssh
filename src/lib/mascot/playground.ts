/**
 * 玛瑟尔在输入框上方的一小块活动区：纯运动模型，不读 DOM、不自己开计时器。
 *
 * x 是人物身体左边相对活动区的距离；lift 是脚底离地高度，向上为正。
 * 边界按真实身体而不是 64 格透明画布计算。组件负责测量、喂指针坐标、画 pose。
 *
 * 跟手方式对照 dsh-Go 的 PetStage / PetOverlay：横向直接跟手，纵向只跟 40%。
 * 身体与点击热区共用 x / lift，**绝不能为了表现重量把两者拆开**；被拽的方向偏移
 * 只发生在内层像素姿态上。松手不跑自由抛物线：先短暂带一点手的余势，再用减速曲线收住。
 */

export interface MascotBounds {
  minX: number;
  maxX: number;
  maxY: number;
}

export interface MascotPlayOptions {
  bounds: MascotBounds;
  bodySize: { width: number; height: number };
  reducedMotion?: boolean;
  random?: () => number;
}

export interface MascotPose {
  x: number;
  lift: number;
  /** 身体内部的轻微拖拽偏移：不动点击热区，不代替跟手。 */
  offsetX: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** 1 = 原画朝向，-1 = 左右镜像（绘制时由画布镜像，不动 DOM 尺寸）。 */
  facing: 1 | -1;
  grabbed: boolean;
}

export type MascotMode = 'idle' | 'dragging' | 'flying' | 'returning' | 'hopping' | 'landing';

export const MASCOT_PLAYGROUND_HEIGHT = 104;

const DRAG_THRESHOLD = 6;
/** dsh-Go 输入框内拖拽：抬起 10dp，向上最多 40dp，纵向只吸收手指位移的 40%。 */
const HOLD_LIFT = 10;
const VERTICAL_FOLLOW = 0.4;
const EXTRA_LIFT = 30;
const EDGE_LIMIT_MIN = 24;
const EDGE_LIMIT_MAX = 56;
/** 只投给快速横向甩动；竖向在松手后放下，不继续往上飞。 */
const MAX_THROW_SPEED = 750;
const RELEASE_MIN_SPEED = 180;
const RELEASE_WINDOW_MS = 85;
const RELEASE_TIMEOUT_MS = 100;
/** 最远只顺势再走约 30px；越近越快收，不能横穿活动区。 */
const RELEASE_DISTANCE = 30;
const SETTLE_SECONDS = 0.26;
/** 身体视觉偏移上限 7px；点击热区和脚底不跟着偏移。 */
const LAG_MAX = 7;
const LAG_PER_SPEED = 0.012;
const POSE_RESPONSE = 28;
const TILT_MAX_DEG = 5;
const STRETCH_MAX = 0.035;
const WALL_RESTITUTION = 0.12;
const MAX_FRAME_DT = 1 / 120;
const GRAVITY = 1700;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteBounds(bounds: MascotBounds): MascotBounds {
  const minX = Number.isFinite(bounds.minX) ? bounds.minX : 0;
  return {
    minX,
    maxX: Math.max(minX, Number.isFinite(bounds.maxX) ? bounds.maxX : minX),
    maxY: Math.max(0, Number.isFinite(bounds.maxY) ? bounds.maxY : 0),
  };
}

/** 到边缘仍有反馈，但越拖越费劲；可拉伸的距离有上限。 */
export function rubberBand(value: number, min: number, max: number, limit: number): number {
  if (value < min) return Math.max(min - limit, min - limit * Math.tanh((min - value) / limit));
  if (value > max) return Math.min(max + limit, max + limit * Math.tanh((value - max) / limit));
  return value;
}

export function initialMascotPose(bounds: MascotBounds): MascotPose {
  return {
    x: finiteBounds(bounds).maxX,
    lift: 0,
    offsetX: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    facing: 1,
    grabbed: false,
  };
}

/** 一个玛瑟尔只存在一种位移；新抓取从当前位置续上。任务表情由 useMascotMood 另管。 */
export class MascotPlayground {
  private bounds: MascotBounds;
  private body: { width: number; height: number };
  private reduced: boolean;
  private random: () => number;
  private pose: MascotPose;
  private mode: MascotMode = 'idle';
  private enabled = true;
  private pointerId: number | null = null;
  private grab = { x: 0, y: 0 };
  private startPointer = { x: 0, y: 0 };
  private moved = false;
  private samples: Array<{ at: number; x: number; lift: number }> = [];
  private velocity = { x: 0, lift: 0 };
  private settle = { fromX: 0, toX: 0, fromLift: 0, elapsed: 0, remaining: 0 };
  private returnTarget = 0;
  private hopRemaining = 0;
  private waitUntil = 0;
  private squash = 0;
  private squashVelocity = 0;
  private tiltTarget = 0;
  private lagTarget = 0;
  private sinceMove = 0;

  constructor(options: MascotPlayOptions) {
    this.bounds = finiteBounds(options.bounds);
    this.body = options.bodySize;
    this.reduced = options.reducedMotion ?? false;
    this.random = options.random ?? Math.random;
    this.pose = initialMascotPose(this.bounds);
  }

  get snapshot(): { pose: MascotPose; mode: MascotMode; dragging: boolean } {
    return { pose: { ...this.pose }, mode: this.mode, dragging: this.mode === 'dragging' && this.moved };
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    if (!reduced) return;
    if (this.mode === 'flying' || this.mode === 'hopping') this.beginReturn();
    if (this.mode === 'landing') this.mode = 'idle';
    this.squash = 0;
    this.squashVelocity = 0;
    this.tiltTarget = 0;
    this.lagTarget = 0;
    if (this.mode === 'dragging') this.clearPose();
  }

  setEnabled(enabled: boolean, now: number): void {
    this.enabled = enabled;
    if (enabled) return;
    if (this.pointerId !== null) this.endGrab(now, false);
    if (this.mode === 'flying' || this.mode === 'hopping' || this.mode === 'landing') this.beginReturn();
    this.waitUntil = 0;
  }

  /** 布局变化只约束当前位置，不把另一段动画的起点强加给它。 */
  resize(bounds: MascotBounds): void {
    this.bounds = finiteBounds(bounds);
    this.pose.x = clamp(this.pose.x, this.bounds.minX, this.bounds.maxX);
    this.pose.lift = clamp(this.pose.lift, this.mode === 'dragging' && !this.reduced ? -10 : 0, this.bounds.maxY);
    this.returnTarget = clamp(this.returnTarget, this.bounds.minX, this.bounds.maxX);
    this.settle.toX = clamp(this.settle.toX, this.bounds.minX, this.bounds.maxX);
    if (this.mode === 'returning' || this.mode === 'flying') this.beginReturn();
  }

  private edgeLimit(): number {
    return clamp((this.bounds.maxX - this.bounds.minX) * 0.12, EDGE_LIMIT_MIN, EDGE_LIMIT_MAX);
  }

  pointerDown(id: number, point: { x: number; y: number }, now: number): boolean {
    if (!this.enabled || this.pointerId !== null) return false;
    this.pointerId = id;
    this.startPointer = { ...point };
    this.moved = false;
    this.waitUntil = 0;
    this.hopRemaining = 0;
    this.velocity = { x: 0, lift: 0 };
    this.squash = 0;
    this.squashVelocity = 0;
    this.tiltTarget = 0;
    this.lagTarget = 0;
    this.sinceMove = 0;
    // point.y 同样是向上为正：抓取点与脚底的高度差。
    this.grab = { x: point.x - this.pose.x, y: point.y - this.pose.lift };
    this.mode = 'dragging';
    this.clearPose();
    this.pose.grabbed = true;
    this.samples = [{ at: now, x: this.pose.x, lift: this.pose.lift }];
    return true;
  }

  pointerMove(id: number, point: { x: number; y: number }, now: number): boolean {
    if (id !== this.pointerId || this.mode !== 'dragging') return false;
    if (!this.moved && Math.hypot(point.x - this.startPointer.x, point.y - this.startPointer.y) >= DRAG_THRESHOLD) {
      this.moved = true;
    }
    if (!this.moved) return true;
    const x = this.reduced
      ? clamp(point.x - this.grab.x, this.bounds.minX, this.bounds.maxX)
      : rubberBand(point.x - this.grab.x, this.bounds.minX, this.bounds.maxX, this.edgeLimit());
    const desiredLift = this.reduced ? 0 : clamp(HOLD_LIFT + (point.y - this.startPointer.y) * VERTICAL_FOLLOW, 0, HOLD_LIFT + EXTRA_LIFT);
    const lift = this.reduced ? clamp(point.y - this.grab.y, 0, this.bounds.maxY) : rubberBand(desiredLift, 0, this.bounds.maxY, 14);
    if (Math.abs(x - this.pose.x) > 0.25) this.pose.facing = x > this.pose.x ? 1 : -1;
    this.pose = { ...this.pose, x, lift, grabbed: true };
    this.sinceMove = 0;
    this.samples.push({ at: now, x, lift });
    while (this.samples.length > 2 && now - this.samples[1].at > RELEASE_WINDOW_MS) this.samples.shift();
    const speed = this.pointerVelocity();
    // 偏移是身体里的「被拽住」，不是一个悬空的第二坐标系。
    this.lagTarget = this.reduced ? 0 : clamp(-speed.x * LAG_PER_SPEED, -LAG_MAX, LAG_MAX);
    this.tiltTarget = this.reduced ? 0 : clamp(-speed.x * 0.004, -TILT_MAX_DEG, TILT_MAX_DEG);
    return true;
  }

  /** false = 轻点，交给原来的戳一下弹跳；true = 已拖拽，吞掉随后的 click。 */
  pointerUp(id: number, now: number, throwNow = true): boolean {
    if (id !== this.pointerId) return false;
    const dragged = this.moved && this.mode === 'dragging';
    this.pointerId = null;
    this.clearPose();
    if (!dragged) {
      if (this.pose.lift === 0) this.mode = 'idle';
      else this.beginReturn();
      return false;
    }
    this.endGrab(now, throwNow);
    return true;
  }

  pointerCancel(id: number, now: number): void {
    if (id === this.pointerId) this.endGrab(now, false);
  }

  private endGrab(now: number, throwNow: boolean): void {
    const speed = this.releaseVelocity(now);
    this.pointerId = null;
    this.clearPose();
    if (this.reduced || !throwNow || this.pose.x < this.bounds.minX || this.pose.x > this.bounds.maxX || this.pose.lift > this.bounds.maxY) {
      this.beginReturn();
      return;
    }
    this.mode = 'returning';
    const direction = Math.abs(speed.x) < RELEASE_MIN_SPEED ? 0 : Math.sign(speed.x);
    const distance = direction * Math.min(RELEASE_DISTANCE, Math.min(MAX_THROW_SPEED, Math.abs(speed.x)) * 0.04);
    this.settle = {
      fromX: this.pose.x,
      toX: clamp(this.pose.x + distance, this.bounds.minX, this.bounds.maxX),
      fromLift: Math.max(0, this.pose.lift),
      elapsed: 0,
      remaining: SETTLE_SECONDS,
    };
    this.velocity = { x: 0, lift: 0 };
  }

  private pointerVelocity(): { x: number; lift: number } {
    const last = this.samples[this.samples.length - 1];
    if (!last) return { x: 0, lift: 0 };
    let first = last;
    for (let i = this.samples.length - 1; i >= 0; i -= 1) {
      first = this.samples[i];
      if (last.at - this.samples[i].at >= RELEASE_WINDOW_MS) break;
    }
    const dt = last.at - first.at;
    if (dt < 8) return { x: 0, lift: 0 };
    return { x: ((last.x - first.x) / dt) * 1000, lift: ((last.lift - first.lift) / dt) * 1000 };
  }

  private releaseVelocity(now: number): { x: number; lift: number } {
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.at > RELEASE_TIMEOUT_MS) return { x: 0, lift: 0 };
    return this.pointerVelocity();
  }

  private clearPose(): void {
    this.pose = { ...this.pose, grabbed: false, offsetX: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    this.tiltTarget = 0;
    this.lagTarget = 0;
  }

  private beginReturn(): void {
    this.mode = 'returning';
    this.returnTarget = clamp(this.pose.x, this.bounds.minX, this.bounds.maxX);
    this.pose.x = this.returnTarget;
    this.settle = { fromX: this.returnTarget, toX: this.returnTarget, fromLift: Math.max(0, this.pose.lift), elapsed: 0, remaining: SETTLE_SECONDS };
    this.velocity = { x: 0, lift: 0 };
    this.clearPose();
  }

  /** dt 单位为秒；长帧切成小片，拖拽姿态不会越过目标抖动。 */
  step(dt: number): void {
    if (!this.enabled || this.mode === 'idle') return;
    let remaining = Math.max(dt, 0);
    // 页面隐藏时 setEnabled 已经收势；这里允许一次长帧结算收势，不能永远差一个 MAX_FRAME_DT。
    if (this.mode === 'returning') remaining = Math.min(remaining, this.settle.remaining);
    while (remaining > 0 && (this.mode as MascotMode) !== 'idle') {
      const slice = Math.min(remaining, MAX_FRAME_DT);
      remaining -= slice;
      this.integrate(slice);
    }
  }

  private integrate(dt: number): void {
    const p = this.pose;
    if (this.mode === 'dragging') {
      this.sinceMove += dt;
      if (this.sinceMove > 0.06) {
        this.lagTarget = 0;
        this.tiltTarget = 0;
      }
      const k = 1 - Math.exp(-dt * POSE_RESPONSE);
      p.offsetX += (this.lagTarget - p.offsetX) * k;
      p.rotation += (this.tiltTarget - p.rotation) * k;
      const stretch = Math.min(STRETCH_MAX, p.lift / 1200);
      p.scaleY = 1 + stretch;
      p.scaleX = 1 - stretch * 0.5;
      return;
    }
    if (this.mode === 'landing') {
      this.stepSquash(dt);
      if (this.squash === 0 && this.squashVelocity === 0) this.mode = 'idle';
      return;
    }
    if (this.mode === 'returning') {
      const consumed = Math.min(dt, this.settle.remaining);
      this.settle.remaining = Math.max(0, this.settle.remaining - consumed);
      this.settle.elapsed += consumed;
      const t = this.settle.elapsed / SETTLE_SECONDS;
      // dsh-Go 放下使用 easeIn；余势收束用快出慢停。两者都在 260ms 内结束。
      const horizontal = 1 - Math.pow(1 - t, 3);
      p.x = this.settle.fromX + (this.settle.toX - this.settle.fromX) * horizontal;
      p.lift = this.settle.fromLift * Math.pow(1 - t, 2);
      if (this.settle.remaining === 0) {
        p.x = this.settle.toX;
        p.lift = 0;
        this.beginLanding(this.settle.fromLift * 4);
      }
      return;
    }

    this.velocity.lift -= GRAVITY * dt;
    this.velocity.x *= Math.exp(-9 * dt);
    p.x += this.velocity.x * dt;
    p.lift += this.velocity.lift * dt;
    if (p.x < this.bounds.minX || p.x > this.bounds.maxX) {
      p.x = clamp(p.x, this.bounds.minX, this.bounds.maxX);
      this.velocity.x *= -WALL_RESTITUTION;
      this.velocity.lift *= 0.8;
    }
    if (p.lift > this.bounds.maxY) {
      p.lift = this.bounds.maxY;
      if (this.velocity.lift > 0) this.velocity.lift *= -0.15;
    }
    p.facing = this.velocity.x >= 0 ? 1 : -1;
    if (p.lift > 0) return;
    p.lift = 0;
    const impact = -this.velocity.lift;
    if (this.mode === 'hopping' && this.hopRemaining > 1) {
      this.hopRemaining -= 1;
      this.startHop();
    } else {
      this.beginLanding(impact);
    }
  }

  private beginLanding(impact: number): void {
    this.velocity = { x: 0, lift: 0 };
    this.clearPose();
    if (this.reduced || impact < 120) {
      this.mode = 'idle';
      return;
    }
    this.mode = 'landing';
    this.squash = clamp(impact / 1000, 0.18, 0.7);
    this.squashVelocity = 0;
    this.pose.scaleX = 1 + this.squash * 0.08;
    this.pose.scaleY = 1 - this.squash * 0.1;
  }

  private stepSquash(dt: number): void {
    const omega = 25;
    this.squashVelocity += (-omega * omega * this.squash - 2 * 0.58 * omega * this.squashVelocity) * dt;
    this.squash += this.squashVelocity * dt;
    if (Math.abs(this.squash) < 0.005 && Math.abs(this.squashVelocity) < 0.05) {
      this.squash = 0;
      this.squashVelocity = 0;
    }
    this.pose.scaleX = 1 + this.squash * 0.08;
    this.pose.scaleY = 1 - this.squash * 0.1;
  }

  /** 到点蹦一两步；false = 无需启动。组件只在 idle、可见、前台时传入 true。 */
  wander(now: number, canWander: boolean): boolean {
    if (!this.enabled || this.reduced || !canWander || this.mode !== 'idle' || this.bounds.maxX - this.bounds.minX < 8) {
      this.waitUntil = 0;
      return false;
    }
    if (!this.waitUntil) {
      this.waitUntil = now + 9000 + this.random() * 9000;
      return false;
    }
    if (now < this.waitUntil) return false;
    this.waitUntil = 0;
    this.mode = 'hopping';
    this.hopRemaining = 1 + Math.floor(this.random() * 2);
    this.startHop();
    return true;
  }

  private startHop(): void {
    const span = this.bounds.maxX - this.bounds.minX;
    const room = Math.min(34, span / 4);
    const left = this.pose.x - this.bounds.minX;
    const right = this.bounds.maxX - this.pose.x;
    const direction = left < room && right >= room ? 1 : right < room && left >= room ? -1 : this.random() < 0.5 ? -1 : 1;
    this.pose.facing = direction > 0 ? 1 : -1;
    this.velocity = { x: direction * 190, lift: 260 };
  }

  dispose(): void {
    this.enabled = false;
    this.pointerId = null;
    this.samples = [];
    this.mode = 'idle';
  }
}
