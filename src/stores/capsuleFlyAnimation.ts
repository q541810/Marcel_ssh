// 交互胶囊飞向右下角动画：基于 Web Animations API + Apple Fluid Interfaces
// 落地时胶囊做弹性回弹（damping≈0.8），尊重 prefers-reduced-motion。

let capsuleTargetEl: HTMLElement | null = null;

export function registerCapsuleTarget(el: HTMLElement | null): void {
  capsuleTargetEl = el;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function pulseCapsuleTarget(): void {
  if (!capsuleTargetEl || typeof capsuleTargetEl.animate !== 'function') return;
  capsuleTargetEl.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.15)' },
      { transform: 'scale(0.95)' },
      { transform: 'scale(1)' },
    ],
    { duration: 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

/**
 * 从起点（默认弹窗中心或按钮位置）飞出金色/琥珀色交互微光球到右下角胶囊位置
 */
export function flyToInteractionCapsule(origin?: { x: number; y: number }): void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;

  const to = capsuleTargetEl
    ? {
        x: capsuleTargetEl.getBoundingClientRect().left + capsuleTargetEl.getBoundingClientRect().width / 2,
        y: capsuleTargetEl.getBoundingClientRect().top + capsuleTargetEl.getBoundingClientRect().height / 2,
      }
    : {
        x: window.innerWidth - 120,
        y: window.innerHeight - 50,
      };

  const from = origin ?? {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };

  if (prefersReducedMotion()) {
    pulseCapsuleTarget();
    return;
  }

  const node = document.createElement('div');
  node.setAttribute('aria-hidden', 'true');
  node.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:28px',
    'height:28px',
    'border-radius:9999px',
    'background:#6366f1', // indigo-500
    'box-shadow:0 4px 14px rgba(99, 102, 241, 0.4)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'pointer-events:none',
    'z-index:99999',
    'will-change:transform,opacity',
  ].join(';');
  node.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>`;

  document.body.appendChild(node);

  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  // 曲线控制点（形成轻微抛物弧线）
  const curveX = from.x + deltaX * 0.4 + (deltaX > 0 ? -40 : 40);
  const curveY = from.y + deltaY * 0.2 - 80;

  const anim = node.animate(
    [
      {
        transform: `translate(${from.x - 16}px, ${from.y - 16}px) scale(1)`,
        opacity: 0.95,
      },
      {
        transform: `translate(${curveX - 16}px, ${curveY - 16}px) scale(1.1)`,
        opacity: 1,
        offset: 0.4,
      },
      {
        transform: `translate(${to.x - 16}px, ${to.y - 16}px) scale(0.6)`,
        opacity: 0.2,
      },
    ],
    {
      duration: 520,
      easing: 'cubic-bezier(0.2, 0.8, 0.25, 1)',
      fill: 'forwards',
    },
  );

  anim.onfinish = () => {
    node.remove();
    pulseCapsuleTarget();
  };
}
