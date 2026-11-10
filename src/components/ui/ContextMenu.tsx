import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MENU_EDGE_GAP, useMenuViewportFit } from '@/hooks/useMenuViewportFit';

export interface ContextMenuItem {
  label: string;
  /** 标题下面一行说明（可选）：两项只差范围时，用一句话讲清各自复制什么。 */
  description?: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  /**
   * `y` 是菜单的哪条边：`below`（默认）= 上边缘，菜单往下长；`above` = 下边缘，
   * 菜单往上长。菜单从触发点朝上弹出时必须用 `above`：下边缘贴死触发点，高度
   * 不用估算，展开动画也从下边缘出发（朝上弹出的菜单从上边缘缩放，会像是飘开的）。
   */
  anchor?: 'below' | 'above';
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, anchor = 'below', items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBounds = { maxHeight: window.innerHeight - MENU_EDGE_GAP * 2, overflowY: 'auto' as const };

  // 菜单项多时（目录树右键有十来项）靠近窗口下/右缘会被裁掉：整张菜单收进屏内（见 hook 注释）。
  useMenuViewportFit(menuRef, x, y, { anchor });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', onClose);
    window.addEventListener('keydown', onKeyDown);
    // 在别处再点一次右键不会产生 click，只会产生 contextmenu；不监听的话旧菜单留着、
    // 新菜单又开出来，屏幕上就叠了两张。必须挂捕获阶段：很多右键处理器（如文件链接芯片）
    // 会 stopPropagation，冒泡阶段根本传不到 window。新菜单是在这次事件分发中途才挂上监听的，
    // 而捕获阶段已经过了，所以不会把自己刚开出来的菜单关掉。
    window.addEventListener('contextmenu', onClose, true);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('contextmenu', onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      // overflow-hidden 且容器不留上下内边距：悬停高亮是铺满整行的方块，留着内边距它既碰不到
      // 菜单边缘（上下各空一截），方角又会戳出圆角轮廓；改成由菜单自己裁切，高亮就铺到边、
      // 角被圆角裁掉。首项/末项用自己的 pt/pb 补回这段间距（见下），文字位置不变。
      className="context-menu-enter fixed z-50 surface-glass rounded-xl overflow-hidden min-w-32 p-1"
      // 菜单比窗口还高时（窗口很矮）封顶并允许内部滚动，末项至少够得着
      style={
        anchor === 'above'
          ? { bottom: window.innerHeight - y, left: x, transformOrigin: 'bottom left', ...menuBounds }
          : { top: y, left: x, ...menuBounds }
      }
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) =>
        item.divider ? (
          <hr key={idx} className="border-edge-subtle my-1" />
        ) : (
          <button
            key={idx}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            // `block` 不能省：<button> 默认 inline-block，菜单是 fixed + 收缩宽度，
            // 各项会被并排算进同一行，菜单宽度成了「各项宽度之和」而不是「最宽一项」。
            className={`block w-full text-left px-3 py-1.5 min-h-7 text-body rounded-md hover:bg-state-soft focus-ring transition-colors duration-120 ${
              item.variant === 'danger' ? 'text-red-400' : 'text-fg'
            }`}
          >
            {item.label}
            {item.description && (
              <span className="block text-meta text-fg-tertiary">{item.description}</span>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
