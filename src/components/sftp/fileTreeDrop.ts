/**
 * 目录树作为本机文件拖入的落点：Tauri 的 drop 事件只给坐标，
 * 这里按坐标找到被指着的树行（行上带 `data-tree-path`）。
 */

export const TREE_PATH_ATTR = 'data-tree-path';

export interface PointerPosition {
  x: number;
  y: number;
}

type ElementFromPoint = (x: number, y: number) => Element | null;

/** 坐标下的目录树行路径；不在任何树行上返回 null。 */
export function treePathAtPoint(
  position: PointerPosition,
  elementFromPoint: ElementFromPoint = (x, y) => document.elementFromPoint(x, y),
): string | null {
  const el = elementFromPoint(position.x, position.y);
  const row = el?.closest?.(`[${TREE_PATH_ATTR}]`);
  return row?.getAttribute(TREE_PATH_ATTR) ?? null;
}

/** 坐标是否落在矩形内。 */
export function pointInRect(
  position: PointerPosition,
  rect: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    position.x >= rect.left &&
    position.x <= rect.right &&
    position.y >= rect.top &&
    position.y <= rect.bottom
  );
}

export type TreeDropTarget =
  | { kind: 'outside' }
  | { kind: 'blank' }
  | { kind: 'row'; path: string };

/**
 * 判定一次拖拽/落下的落点：不在树区域 → outside（按原逻辑传到当前目录）；
 * 在树区域但没指着任何行 → blank（忽略）；指着行 → row（上传到该目录）。
 */
export function resolveTreeDropTarget(
  position: PointerPosition | undefined,
  treeRect: { left: number; right: number; top: number; bottom: number } | null,
  treeVisible: boolean,
  elementFromPoint?: ElementFromPoint,
): TreeDropTarget {
  if (!position || !treeRect || !treeVisible) return { kind: 'outside' };
  if (!pointInRect(position, treeRect)) return { kind: 'outside' };
  const path = treePathAtPoint(position, elementFromPoint);
  return path ? { kind: 'row', path } : { kind: 'blank' };
}
