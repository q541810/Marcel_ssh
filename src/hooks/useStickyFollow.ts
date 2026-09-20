import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { isNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from '@/lib/agentScroll';

/**
 * 是否还需要贴底跟随的判定必须在 layout effect 里同步完成：effect 跑在绘制之后，
 * 每来一批新内容都会先闪一帧"停在老位置"再跳过去。
 * （SSR/`renderToStaticMarkup` 下没有 DOM，layout effect 会告警，退回 effect。）
 */
export const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface StickyFollow<T extends HTMLElement> {
  /** 挂到滚动容器上的 ref。 */
  ref: RefObject<T>;
  /** 挂到同一个容器的 onScroll。 */
  onScroll: () => void;
  /** 内容变长之后调用：用户还在底部就贴到底，上翻了就什么都不做。 */
  follow: () => void;
  /** 重新开始跟随（例如用户重新展开）。 */
  restart: () => void;
}

/**
 * 内嵌滚动区的「贴底跟随」：流式内容增长时，只要用户还在底部就把视口跟到最新一行。
 *
 * 关键在"用户还在不在底部"这个判断来自哪里 —— 只能来自 `onScroll` 记下的状态，
 * **不能**在内容变长之后再量 `scrollHeight - scrollTop - clientHeight`：
 * 那时量到的是"这一批新增了多少"（scrollTop 不会跟着内容一起长），阈值一超
 * 差值就永远补不回来，跟随会永久停住 —— 画面停在老内容上，用户只能手动往下拖。
 *
 * 用法：`ref` 与 `onScroll` 挂到同一个滚动容器；内容变化后用
 * `useIsomorphicLayoutEffect` 调 `follow()`。
 */
export function useStickyFollow<T extends HTMLElement>(
  thresholdPx: number = NEAR_BOTTOM_THRESHOLD_PX,
): StickyFollow<T> {
  const ref = useRef<T>(null);
  /** 用户是否还在底部。初值 true：内容从空开始长，一开始当然是在底部。 */
  const pinnedRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current = isNearBottom(
      el.scrollTop,
      el.clientHeight,
      el.scrollHeight,
      thresholdPx,
    );
  }, [thresholdPx]);

  const follow = useCallback(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const restart = useCallback(() => {
    pinnedRef.current = true;
  }, []);

  return { ref, onScroll, follow, restart };
}
