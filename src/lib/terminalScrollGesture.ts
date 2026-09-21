/**
 * 滚动手势 → 远端输入：备用屏幕里的滚动转发（tmux / vim / less / htop 等全屏程序）。
 *
 * xterm 5.5 只有「桌面滚轮」这一条路会在备用屏幕里转发滚动——`Terminal.bindMouse()`
 * 里，远端开了鼠标上报（vt200 / drag / any）就发 SGR 滚轮报告，否则把滚轮翻译成
 * 等量 ↑/↓ 方向键（alt-scroll）。**触摸手势没有这条通路**：`Viewport.handleTouchMove()`
 * 只改 `.xterm-viewport` 的 scrollTop，而备用屏幕没有回滚缓冲，于是手指划动什么都
 * 不会发生（上游到 6.0 之后才补上 touch → 滚轮 / 方向键的转换）。
 *
 * 这里补的就是触摸那条通路：把「要滚多少行」翻译成**合成 wheel 事件派发回 xterm**，
 * 由 xterm 自己决定发什么——鼠标上报开着就发滚轮报告（tmux 收到进 copy-mode 翻历史，
 * 与 Termius 的行为一致），没开就发方向键。这样协议与编码（SGR / VT200、
 * applicationCursorKeys）都不用我们复刻一份，将来升级 xterm 也跟着走。
 * 派发目标就是 xterm 自己挂监听的那个元素（`Terminal.bindMouse` 里的 `this.element`），
 * 普通缓冲不接管——那里 xterm 原生 follow-finger 正常工作。
 */

/** 一格滚轮折算多少行：对齐桌面滚轮的常规节奏（xterm 把一格滚轮翻成 3 行方向键）。 */
export const WHEEL_LINES_PER_NOTCH = 3;

/**
 * 单次转发最多交出多少行（≈ 一屏）。惯性甩动的速度是两帧位移 / 两帧间隔估出来的，
 * 采样间隔极小的一对事件能动不动给出几十上百行一帧的量级；本地滚动有「滚到头」
 * 兜底（`viewportY` 不变就停），远端没有这个反馈，所以这里封顶，多余的直接丢，
 * 免得一次性把几千个滚轮报告灌给 tmux。正常甩动一帧只有几行，碰不到这个上限。
 */
export const MAX_REMOTE_LINES_PER_FORWARD = 24;

/** 量不到行高时的兜底（与移动端惯性滚动同一口径）。 */
export const DEFAULT_ROW_HEIGHT_PX = 16;

/** 合成 wheel 事件用的 deltaMode：DOM_DELTA_LINE，让 xterm 按行折算而不是按像素。 */
const DOM_DELTA_LINE = 1;

export interface LineAccumulatorResult {
  lines: number;
  residualPx: number;
}

/** 像素位移 + 余量 → 整行数。 */
export function consumeLines(
  deltaPx: number,
  residualPx: number,
  rowHeightPx: number,
): LineAccumulatorResult {
  if (!(rowHeightPx > 0)) {
    return { lines: 0, residualPx: residualPx + deltaPx };
  }
  const total = residualPx + deltaPx;
  const lines = total > 0 ? Math.floor(total / rowHeightPx) : Math.ceil(total / rowHeightPx);
  return {
    lines,
    residualPx: total - lines * rowHeightPx,
  };
}

export interface LineAccumulator {
  /** 累计像素位移，返回本次凑满的整行数（含此前未凑满的余量）。 */
  add(deltaPx: number): number;
  reset(): void;
}

/**
 * 把手指的像素位移攒成整行数：不足一行的余量留到下次，慢速拖动才不会每帧都被
 * 取整抹掉。follow-finger 与惯性甩动共用同一个实例时，抬手那一下的余量还能接着用。
 */
export function createLineAccumulator(getRowHeightPx: () => number): LineAccumulator {
  let residualPx = 0;
  return {
    add(deltaPx: number): number {
      // NaN / Infinity 一旦进了余量就再也洗不掉（之后每帧都算不出行数），当场丢掉。
      if (!Number.isFinite(deltaPx)) return 0;
      const result = consumeLines(deltaPx, residualPx, getRowHeightPx());
      residualPx = result.residualPx;
      return result.lines;
    },
    reset(): void {
      residualPx = 0;
    },
  };
}

export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/**
 * 远端程序收不收滚轮报告。xterm 的鼠标协议表里 vt200 / drag / any 带 WHEEL 事件，
 * X10（DECSET 9）明确不带（`common/services/CoreMouseService.ts` 的 DEFAULT_PROTOCOLS），
 * 所以 DECSET 9 下滚轮只能走方向键那条路。
 */
export function appAcceptsWheelReports(mode: MouseTrackingMode): boolean {
  switch (mode) {
    case 'vt200':
    case 'drag':
    case 'any':
      return true;
    case 'none':
    case 'x10':
      return false;
  }
}

/** 行数 → 整格滚轮 + 余量（余量同样留到下次）。 */
export function consumeWheelNotches(
  lines: number,
  residual: number,
  linesPerNotch: number = WHEEL_LINES_PER_NOTCH,
): { notches: number; residual: number } {
  if (!(linesPerNotch > 0)) {
    return { notches: 0, residual: residual + lines };
  }
  const total = residual + lines;
  const raw = total > 0 ? Math.floor(total / linesPerNotch) : Math.ceil(total / linesPerNotch);
  // `Math.ceil(-0.3)` 得到的是 -0：归一成 0，别让 -0 漏给调用方（Object.is 下 -0 ≠ 0）。
  return { notches: raw === 0 ? 0 : raw, residual: total - raw * linesPerNotch };
}

export interface ScrollPoint {
  clientX: number;
  clientY: number;
}

export interface SyntheticWheelInit extends ScrollPoint {
  deltaY: number;
  deltaMode: typeof DOM_DELTA_LINE;
}

export interface RemoteScrollPlan {
  events: SyntheticWheelInit[];
  residual: number;
}

/**
 * 行数 → 要派发的合成 wheel 事件。两个分支粒度不同，因为 xterm 对二者的解释不同：
 * - 远端收滚轮：**一次事件 = 一格滚轮**，报告里不带幅度，所以拖多少行就得凑够多少格
 *   （凑不满就攒着），一格滚轮 tmux 翻 5 行 / less、vim 翻 3 行。
 * - 远端不收滚轮：xterm 按 |deltaY| 发等量方向键，所以整行位移一次交出去即可。
 *
 * 两条路都先把行数按 MAX_REMOTE_LINES_PER_FORWARD 封顶（甩动的极端速度兜底）。
 */
export function planRemoteScroll(args: {
  lines: number;
  residual: number;
  acceptsWheel: boolean;
  point: ScrollPoint;
  linesPerNotch?: number;
}): RemoteScrollPlan {
  if (args.lines === 0) {
    return { events: [], residual: args.residual };
  }
  const lines = Math.max(
    -MAX_REMOTE_LINES_PER_FORWARD,
    Math.min(MAX_REMOTE_LINES_PER_FORWARD, args.lines),
  );
  const { clientX, clientY } = args.point;
  if (!args.acceptsWheel) {
    return {
      events: [{ deltaY: lines, deltaMode: DOM_DELTA_LINE, clientX, clientY }],
      residual: 0,
    };
  }
  const { notches, residual } = consumeWheelNotches(lines, args.residual, args.linesPerNotch);
  const deltaY = notches > 0 ? 1 : -1;
  const events: SyntheticWheelInit[] = [];
  for (let i = 0; i < Math.abs(notches); i++) {
    events.push({ deltaY, deltaMode: DOM_DELTA_LINE, clientX, clientY });
  }
  return { events, residual };
}

/** 转发滚动所需的最小 xterm 面（结构类型，便于测试替身）。 */
export interface RemoteScrollTerminal {
  modes: { mouseTrackingMode: MouseTrackingMode };
  element?: { dispatchEvent(event: Event): boolean } | null;
  buffer: { active: { type: 'normal' | 'alternate' } };
}

export interface RemoteScrollForwarder {
  /** 行数正负与 `term.scrollLines` 同向：正 = 往新内容滚。 */
  forward(lines: number, at: ScrollPoint): void;
  /** 新手势开始前清掉未凑满一格的行数。 */
  reset(): void;
}

export function createRemoteScrollForwarder(
  getTerminal: () => RemoteScrollTerminal | null,
): RemoteScrollForwarder {
  let residual = 0;
  return {
    reset(): void {
      residual = 0;
    },
    forward(lines: number, at: ScrollPoint): void {
      if (lines === 0 || !Number.isFinite(lines)) return;
      const term = getTerminal();
      const element = term?.element;
      if (!term || !element) return;
      // 普通缓冲有回滚缓冲，用户要的是本地滚动，xterm 自己就干了。
      if (term.buffer.active.type !== 'alternate') return;
      const plan = planRemoteScroll({
        lines,
        residual,
        acceptsWheel: appAcceptsWheelReports(term.modes.mouseTrackingMode),
        point: at,
      });
      residual = plan.residual;
      for (const init of plan.events) {
        // bubbles: false —— 合成事件只喂给 xterm 自己的监听，不惊动上层（宿主/插件）的
        // wheel 监听。xterm 挂在 .xterm 元素上，直接派发到它身上即可。
        element.dispatchEvent(new WheelEvent('wheel', { ...init, bubbles: false, cancelable: true }));
      }
    },
  };
}

export interface AltScreenTouchScrollOptions {
  container: HTMLElement;
  getTerminal: () => (RemoteScrollTerminal & { rows: number }) | null;
  forward: (lines: number, at: ScrollPoint) => void;
  rowHeightFallbackPx?: number;
}

export interface AltScreenTouchScrollHandle {
  dispose: () => void;
}

/** 容器里量到的行高；量不到时用兜底值（隐藏 / 未布局）。 */
export function measureRowHeightPx(
  container: ParentNode,
  rows: number,
  fallbackPx: number = DEFAULT_ROW_HEIGHT_PX,
): number {
  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (viewport && rows > 0 && viewport.clientHeight > 0) {
    return viewport.clientHeight / rows;
  }
  return fallbackPx;
}

/**
 * 触摸屏上的备用屏幕滚动（桌面端用；移动端的 follow-finger 与惯性甩动由
 * `attachXtermMomentumScroll` 统一管，别重复接）。只在备用屏幕里接管手指位移，
 * 普通缓冲原样留给 xterm 原生 follow-finger；监听是 passive 的，不 preventDefault。
 */
export function attachAltScreenTouchScroll(
  options: AltScreenTouchScrollOptions,
): AltScreenTouchScrollHandle {
  const fallbackPx = options.rowHeightFallbackPx ?? DEFAULT_ROW_HEIGHT_PX;
  const accumulator = createLineAccumulator(() => {
    const term = options.getTerminal();
    return term ? measureRowHeightPx(options.container, term.rows, fallbackPx) : fallbackPx;
  });
  let lastY: number | null = null;

  const onTouchStart = (ev: TouchEvent) => {
    accumulator.reset();
    lastY = ev.touches.length === 1 ? ev.touches[0]!.clientY : null;
  };

  const onTouchMove = (ev: TouchEvent) => {
    if (lastY === null || ev.touches.length !== 1) return;
    const term = options.getTerminal();
    if (!term || term.buffer.active.type !== 'alternate') {
      // 中途切回普通缓冲（退出 tmux / vim）：这段手势就此放弃，交还 xterm。
      lastY = null;
      return;
    }
    const touch = ev.touches[0]!;
    // 手指上移 → clientY 变小 → 正 = 往新内容滚，与 term.scrollLines 同向。
    const lines = accumulator.add(lastY - touch.clientY);
    lastY = touch.clientY;
    if (lines !== 0) {
      options.forward(lines, { clientX: touch.clientX, clientY: touch.clientY });
    }
  };

  const onTouchEnd = () => {
    lastY = null;
    accumulator.reset();
  };

  const el = options.container;
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return {
    dispose: () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    },
  };
}
