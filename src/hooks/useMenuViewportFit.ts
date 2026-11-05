import { useLayoutEffect, type RefObject } from 'react';

/** 菜单与窗口边缘至少留的空隙。 */
export const MENU_EDGE_GAP = 8;

/**
 * 把弹出菜单（`position: fixed`，锚在 `x`/`y`）收进窗口：整张菜单都在屏内，末项不会被切掉。
 * 右键菜单一律经它定位（`ContextMenu`、文件列表 / 进程列表的行内菜单共用，别各写一套）。
 *
 * 三个要点，漏一个都会让末项（「删除」）被切掉：
 *  1. 量 `offsetWidth/offsetHeight`（布局尺寸）而不是 `getBoundingClientRect`：入场动画开头是
 *     `scale(0.95)`，后者量到的是缩小后的尺寸，低估了溢出量；
 *  2. 菜单尺寸会在打开之后变（项目根目录这类异步结果到了才多出一项）：`ResizeObserver` 盯着，变了重算；
 *  3. 窗口大小变了也要重算。
 *
 * 直接写 DOM 的 `left/top`（布局阶段、先于绘制，不闪）。`bottom` 锚定的菜单（`anchor: 'above'`，
 * 往上长）只收横向。
 */
export function useMenuViewportFit(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  options: { anchor?: 'below' | 'above'; enabled?: boolean } = {},
): void {
  const { anchor = 'below', enabled = true } = options;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const fit = () => {
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const maxLeft = window.innerWidth - width - MENU_EDGE_GAP;
      node.style.left = `${Math.max(MENU_EDGE_GAP, Math.min(x, maxLeft))}px`;
      if (anchor === 'above') return;
      const maxTop = window.innerHeight - height - MENU_EDGE_GAP;
      node.style.top = `${Math.max(MENU_EDGE_GAP, Math.min(y, maxTop))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(node);
    window.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [ref, x, y, anchor, enabled]);
}
