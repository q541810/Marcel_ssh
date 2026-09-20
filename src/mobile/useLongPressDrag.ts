import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 移动端长按拖拽排序 hook。
 *
 * 交互模型（对齐 iOS 列表重排的手感）：
 * - 按下后保持 LONG_PRESS_MS 不动（移动超过阈值则取消，让位给页面滚动）；
 * - 激活时轻微触觉反馈，卡片进入 1:1 跟手拖拽（document 坐标系，
 *   自动滚动的补偿包含在内）；
 * - 其他卡片实时腾位（transform 过渡滑动；prefers-reduced-motion 时瞬时）；
 * - 接近视口上下边缘自动滚动；
 * - 松手提交新顺序（onCommit），取消（touchcancel）则原样还原。
 *
 * 几何说明：激活时一次性测量所有卡片在 document 空间的 top/height，
 * 拖拽期间不再读取布局（避免读到 transform 后的值）；其他卡片的腾位
 * 位移 = 目标槽位的原始 top − 自身原始 top。
 */

const LONG_PRESS_MS = 320;
/** 长按等待期间允许的最大位移（px），超过视为滚动意图并取消 */
const PRESS_CANCEL_THRESHOLD = 10;
/** 视口边缘自动滚动的触发距离与速度 */
const EDGE_MARGIN = 56;
const EDGE_SCROLL_SPEED = 12;

interface DragState {
  id: string;
  /** 卡片在滚动坐标系下的原始 top（按传入顺序索引） */
  tops: number[];
  heights: number[];
  ids: string[];
  /** slots[k] = 当前占据第 k 个槽位的原始索引 */
  slots: number[];
  draggedOrigIdx: number;
  grabOffsetDoc: number;
  lastClientY: number;
}

/**
 * 向上找第一个真正能滚动的祖先（`overflow-y: auto|scroll` 且内容超出容器）。
 *
 * 移动端的列表不是窗口滚的（`html,body` 是 `position: fixed`）：滚动的是列表自己
 * 那个 `overflow-y-auto` 的内层容器，所以坐标系要用**它的** `scrollTop`，边缘自动
 * 滚动也要滚**它** —— 拿 `window.scrollY`/`window.scrollBy` 在这个容器上是恒 0 的
 * 死代码，长列表只能排可见的那一屏。
 */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export interface LongPressDragApi {
  draggingId: string | null;
  registerItem: (id: string) => (el: HTMLElement | null) => void;
  onTouchStart: (id: string) => (e: React.TouchEvent) => void;
  onTouchMovePending: (e: React.TouchEvent) => void;
  onTouchEndPending: () => void;
  /** 拖拽中非被拖拽卡片的位移样式；空闲或被拖拽卡片返回 undefined */
  translateFor: (id: string) => string | undefined;
  /** 是否处于拖拽中（用于附加过渡/层级样式） */
  isDragging: boolean;
  /** 点击抑制：长按激活后的合成点击应被忽略 */
  shouldSuppressClick: () => boolean;
}

export function useLongPressDrag(opts: {
  orderedIds: string[];
  onCommit: (orderedIds: string[]) => void;
}): LongPressDragApi {
  const { orderedIds, onCommit } = opts;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const itemEls = useRef(new Map<string, HTMLElement>());
  const pressTimer = useRef<number | null>(null);
  const pendingStartY = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const drag = useRef<DragState | null>(null);
  const listeners = useRef<{
    move: (e: TouchEvent) => void;
    end: () => void;
    cancel: () => void;
  } | null>(null);
  const suppressClickUntil = useRef(0);
  const reducedMotion = useRef(false);
  // onCommit 可能随渲染变化，拖拽期间固定引用
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    reducedMotion.current =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const haptic = useCallback((ms: number) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* 设备不支持时静默 */
    }
  }, []);

  const finish = useCallback((commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pendingStartY.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const l = listeners.current;
    if (l) {
      window.removeEventListener('touchmove', l.move);
      window.removeEventListener('touchend', l.end);
      window.removeEventListener('touchcancel', l.cancel);
      listeners.current = null;
    }
    if (d) {
      // 被拖拽卡片的内联位移由这里清除；其余卡片随渲染还原
      const el = itemEls.current.get(d.id);
      if (el) el.style.transform = '';
      // 点击抑制要在**拖拽结束**这一刻再续一段：松手才会触发合成 click，
      // 而激活时那个固定的 +1000ms 窗口会在「长按 + 拖了一阵」的拖拽里提前
      // 到期，抬起时卡片的 onClick 照走 —— 表现为误触发起连接。
      suppressClickUntil.current = Date.now() + 350;
      if (commit) {
        const newIds = d.slots.map((origIdx) => d.ids[origIdx]);
        const changed = newIds.some((id, i) => id !== d.ids[i]);
        if (changed) {
          haptic(10);
          onCommitRef.current(newIds);
        }
      }
    }
    setDraggingId(null);
    setTick((t) => t + 1);
  }, [haptic]);

  // 卸载时中止拖拽，避免泄漏监听
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(false), []);

  const activate = useCallback(
    (id: string, startClientY: number) => {
      const els = orderedIds.map((i) => itemEls.current.get(i));
      if (els.some((el) => !el)) return;
      // 坐标系统一用「滚动坐标系」：元素 rect.top + 滚动容器的 scrollTop 不随滚动
      // 变化，这样被拖行 1:1 跟手、其他行腾位、指针/槽位判定在滚动过程中都成立。
      // 移动端绝大多数情况是列表自己的内层容器在滚，窗口根本不滚（window.scrollY
      // 恒 0）。
      const scrollParent = findScrollParent(itemEls.current.get(id) ?? null);
      const scrollTop = () => scrollParent?.scrollTop ?? window.scrollY;
      const scrollBounds = scrollParent?.getBoundingClientRect() ?? null;
      const tops = (els as HTMLElement[]).map(
        (el) => el.getBoundingClientRect().top + scrollTop(),
      );
      const heights = (els as HTMLElement[]).map((el) => el.offsetHeight || 1);
      const draggedOrigIdx = orderedIds.indexOf(id);
      if (draggedOrigIdx === -1) return;
      const state: DragState = {
        id,
        tops,
        heights,
        ids: [...orderedIds],
        slots: orderedIds.map((_, i) => i),
        draggedOrigIdx,
        grabOffsetDoc: startClientY + scrollTop() - tops[draggedOrigIdx],
        lastClientY: startClientY,
      };
      drag.current = state;
      setDraggingId(id);
      suppressClickUntil.current = Date.now() + 1000;
      haptic(15);

      const updateFrame = () => {
        const d = drag.current;
        if (!d) return;
        const docPointer = d.lastClientY + scrollTop();
        const desiredTop = docPointer - d.grabOffsetDoc;
        const el = itemEls.current.get(d.id);
        if (el) {
          el.style.transform = `translate3d(0, ${desiredTop - d.tops[d.draggedOrigIdx]}px, 0)`;
        }
        // 以被拖拽卡片中心与其他卡片中心的相对位置计算插入槽位
        const center = desiredTop + d.heights[d.draggedOrigIdx] / 2;
        let newSlot = 0;
        for (let k = 0; k < d.slots.length; k++) {
          const oi = d.slots[k];
          if (oi === d.draggedOrigIdx) continue;
          if (center > d.tops[k] + d.heights[oi] / 2) newSlot++;
        }
        const curSlot = d.slots.indexOf(d.draggedOrigIdx);
        if (newSlot !== curSlot) {
          d.slots.splice(curSlot, 1);
          d.slots.splice(newSlot, 0, d.draggedOrigIdx);
          haptic(5);
          setTick((t) => t + 1);
        }
      };

      const onMove = (e: TouchEvent) => {
        const d = drag.current;
        if (!d) return;
        e.preventDefault(); // 拖拽期间接管触摸，阻止页面滚动
        d.lastClientY = e.touches[0].clientY;
        updateFrame();
      };
      const onEnd = () => finish(true);
      const onCancel = () => finish(false);
      listeners.current = { move: onMove, end: onEnd, cancel: onCancel };
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onCancel);

      // 边缘自动滚动（rAF 与显示器同步）：滚的是「滚动容器」本身，不是窗口 ——
      // 移动端 `html,body` 是 fixed、窗口根本不滚，原代码的 `window.scrollBy`
      // 在这类容器上是恒 0 的死代码，长列表只能排可见的那一屏。
      const step = () => {
        const d = drag.current;
        if (!d) return;
        const top = scrollBounds?.top ?? 0;
        const bottom = scrollBounds?.bottom ?? window.innerHeight;
        const dy =
          d.lastClientY < top + EDGE_MARGIN
            ? -EDGE_SCROLL_SPEED
            : d.lastClientY > bottom - EDGE_MARGIN
              ? EDGE_SCROLL_SPEED
              : 0;
        if (dy !== 0) {
          if (scrollParent) scrollParent.scrollBy(0, dy);
          else window.scrollBy(0, dy);
        }
        updateFrame();
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [orderedIds, finish, haptic],
  );

  const onTouchStart = useCallback(
    (id: string) => (e: React.TouchEvent) => {
      if (drag.current || pressTimer.current != null) return;
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-nodrag]')) return;
      const y = e.touches[0].clientY;
      pendingStartY.current = y;
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        pendingStartY.current = null;
        activate(id, y);
      }, LONG_PRESS_MS);
    },
    [activate],
  );

  /** 未激活阶段的移动：超过阈值视为滚动意图，取消长按 */
  const onTouchMovePending = useCallback((e: React.TouchEvent) => {
    if (drag.current || pressTimer.current == null) return;
    if (pendingStartY.current == null || e.touches.length !== 1) return;
    if (Math.abs(e.touches[0].clientY - pendingStartY.current) > PRESS_CANCEL_THRESHOLD) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
      pendingStartY.current = null;
    }
  }, []);

  /** 未激活阶段抬起：清除待定长按（正常点击不受影响） */
  const onTouchEndPending = useCallback(() => {
    if (!drag.current && pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
      pendingStartY.current = null;
    }
  }, []);

  const translateFor = useCallback((id: string): string | undefined => {
    const d = drag.current;
    if (!d || id === d.id) return undefined;
    const origIdx = d.ids.indexOf(id);
    const slot = d.slots.indexOf(origIdx);
    if (origIdx === -1 || slot === -1) return undefined;
    const ty = d.tops[slot] - d.tops[origIdx];
    return ty ? `translate3d(0, ${ty}px, 0)` : undefined;
  }, []);

  const shouldSuppressClick = useCallback(
    () => Date.now() < suppressClickUntil.current,
    [],
  );

  return {
    draggingId,
    registerItem: useCallback(
      (id: string) => (el: HTMLElement | null) => {
        if (el) itemEls.current.set(id, el);
        else itemEls.current.delete(id);
      },
      [],
    ),
    onTouchStart,
    onTouchMovePending,
    onTouchEndPending,
    translateFor,
    isDragging: draggingId != null,
    shouldSuppressClick,
  };
}
