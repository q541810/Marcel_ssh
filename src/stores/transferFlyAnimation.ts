// 传输任务"飞入传输中心"动画：零依赖，基于 Web Animations API。
// 遵循 Apple Fluid Interfaces 要点：仅动 transform/opacity（合成器友好），
// 落地时目标按钮做欠阻尼回弹以呼应因果，尊重 prefers-reduced-motion。

export type TransferFlyKind = 'upload' | 'download';

let targetEl: HTMLElement | null = null;
let lastPointer: { x: number; y: number } | null = null;

// 记录用户最后一次指针位置，作为飞行起点（即他刚点击的按钮/菜单/落点）。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true },
  );
}

/** 传输中心按钮挂载时注册自身，卸载时传 null 注销。 */
export function registerTransferTarget(el: HTMLElement | null): void {
  targetEl = el;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 目标按钮欠阻尼回弹（damping≈0.8），表达"任务已落入此处"。 */
function pulseTarget(): void {
  if (!targetEl || typeof targetEl.animate !== 'function') return;
  targetEl.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.28)' },
      { transform: 'scale(0.96)' },
      { transform: 'scale(1)' },
    ],
    { duration: 440, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

function makeFlyNode(kind: TransferFlyKind): HTMLDivElement {
  const node = document.createElement('div');
  node.setAttribute('aria-hidden', 'true');
  const color = kind === 'download' ? '#10b981' : '#6366f1'; // emerald-500 / indigo-500
  // 上传箭头向上，下载箭头向下
  const path =
    kind === 'download'
      ? 'M12 4v13m0 0l-5-5m5 5l5-5' // down
      : 'M12 20V7m0 0l-5 5m5-5l5 5'; // up
  node.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:26px',
    'height:26px',
    'border-radius:9999px',
    `background:${color}`,
    'box-shadow:0 6px 16px rgba(0,0,0,0.35)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'pointer-events:none',
    'z-index:9999',
    'will-change:transform,opacity',
  ].join(';');
  node.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  return node;
}

/**
 * 从起点（默认取用户最后指针位置）飞一个小图标到传输中心按钮，落地后按钮回弹。
 * 无目标 / 无起点 / 环境不支持时安全降级（仅回弹或直接跳过）。
 */
export function flyToTransferCenter(kind: TransferFlyKind, origin?: { x: number; y: number }): void {
  if (!targetEl) return;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;

  const from = origin ?? lastPointer;

  // 减弱动效或无起点：只做落地回弹反馈，不飞行。
  if (!from || prefersReducedMotion()) {
    pulseTarget();
    return;
  }

  const rect = targetEl.getBoundingClientRect();
  const to = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

  const node = makeFlyNode(kind);
  if (typeof node.animate !== 'function') {
    pulseTarget();
    return;
  }
  document.body.appendChild(node);

  // 抛物线中点：水平取中，垂直抬到两点更高处之上，形成上抛的弧线（§8 沿手势方向暗示去向）。
  const midX = (from.x + to.x) / 2;
  const midY = Math.min(from.y, to.y) - 56;

  const center = 'translate(-50%,-50%)';
  const anim = node.animate(
    [
      { transform: `translate(${from.x}px,${from.y}px) ${center} scale(0.6)`, opacity: 0, offset: 0 },
      { transform: `translate(${from.x}px,${from.y}px) ${center} scale(1)`, opacity: 1, offset: 0.12 },
      { transform: `translate(${midX}px,${midY}px) ${center} scale(1.05)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${to.x}px,${to.y}px) ${center} scale(0.28)`, opacity: 0, offset: 1 },
    ],
    { duration: 640, easing: 'cubic-bezier(0.32, 0.0, 0.2, 1)', fill: 'forwards' },
  );

  const cleanup = () => {
    node.remove();
    pulseTarget();
  };
  anim.onfinish = cleanup;
  anim.oncancel = () => node.remove();
}
