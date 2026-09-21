import type { KeyboardEvent, PointerEvent } from 'react';

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

interface SplitHandleProps {
  /** aria-label，例如「调整侧边栏宽度」。 */
  label: string;
  /** 当前显示宽度（px），用于 aria-valuenow。 */
  value: number;
  /** 可调范围的显示宽度（px）。 */
  min: number;
  max: number;
  /** 拖动中：整条点亮。 */
  active: boolean;
  /** 没有可调空间时不提示可拖动（仍可聚焦，方向键自然也是空操作）。 */
  draggable: boolean;
  /** 方向键语义：+1 = 右方向键让面板变宽，-1 = 左方向键让面板变宽（把手在面板左缘时）。 */
  growDirection: 1 | -1;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void;
  /** 方向键步进（正数 = 变宽）。 */
  onNudge: (delta: number) => void;
  /** 双击回到默认宽度。 */
  onReset: () => void;
}

/**
 * 左右两栏之间的竖向分隔条。
 *
 * 可见只有 4px，命中区靠一个隐形子元素扩到 12px（与 SFTP 目录树那根一致）：
 * 4px 的针眼要瞄准才能拖，是这套交互最直接的「难受」来源。
 * 静止时不可见，hover / 拖动 / 聚焦才点亮，让「这里能拖」有迹可循。
 */
export default function SplitHandle({
  label,
  value,
  min,
  max,
  active,
  draggable,
  growDirection,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onNudge,
  onReset,
}: SplitHandleProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    onNudge((e.key === 'ArrowRight' ? step : -step) * growDirection);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // 焦点守卫放在 mousedown 而不是 pointerdown：取消 mousedown 的默认动作
      // （聚焦、起选区）是各引擎一致的做法，同时不会掐掉后续的 click / dblclick
      // ——双击复位要靠它。拖动本身走 Pointer 事件，取消 mousedown 不影响。
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      className={`group relative z-10 w-1 flex-shrink-0 ${
        draggable ? 'cursor-col-resize' : 'cursor-default'
      }`}
      style={{ touchAction: 'none' }}
    >
      {/* 隐形命中区：可见 4px + 两侧各 4px */}
      <div aria-hidden className="absolute inset-y-0 -left-1 -right-1" />
      {/* 指示条：静态不可见，hover / 拖动 / 聚焦点亮 */}
      <div
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 bg-indigo-500 transition-opacity duration-150 ${
          active ? 'opacity-70' : 'opacity-0 group-hover:opacity-40 group-focus-visible:opacity-60'
        }`}
      />
    </div>
  );
}
