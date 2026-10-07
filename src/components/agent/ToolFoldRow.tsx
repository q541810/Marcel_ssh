import { useRef, type ReactNode } from 'react';
import { useIsomorphicLayoutEffect } from '@/hooks/useStickyFollow';
import { TOOL_FOLD_DURATION } from './useToolFoldTransition';
import type { ToolGroupReveal } from './toolGroupReveal';

/** Group members share one reveal boundary in both directions. */
export default function ToolFoldRow({ rowKey, exiting, entering = false, onExitComplete,
  onEnterComplete, onMountChange, children, reveal, revealGroup, compact = false }: {
  rowKey: string; exiting: boolean; entering?: boolean; children: ReactNode;
  onExitComplete?: (key: string) => void;
  onEnterComplete?: (key: string) => void;
  onMountChange?: (key: string, mounted: boolean) => void;
  reveal?: ToolGroupReveal;
  revealGroup?: string;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const interrupted = useRef<{ height: number; opacity: string } | null>(null);
  const callbacks = useRef({ onExitComplete, onEnterComplete });
  callbacks.current = { onExitComplete, onEnterComplete };
  useIsomorphicLayoutEffect(() => {
    onMountChange?.(rowKey, true);
    return () => onMountChange?.(rowKey, false);
  }, [rowKey, onMountChange]);
  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const finishCallback = () => exiting
      ? callbacks.current.onExitComplete?.(rowKey) : callbacks.current.onEnterComplete?.(rowKey);
    if (!exiting && !entering) { interrupted.current = null; return; }
    if (!node.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      interrupted.current = null;
      finishCallback();
      return;
    }
    const start = interrupted.current;
    interrupted.current = null;
    if (reveal && revealGroup && node.firstElementChild instanceof HTMLElement) {
      let completed = false;
      const unregister = reveal.register(`${revealGroup}:${exiting ? 'close' : 'open'}`, rowKey, node, node.firstElementChild, () => {
        completed = true;
        finishCallback();
      }, start?.height ?? (exiting ? node.getBoundingClientRect().height : 0), exiting);
      return () => {
        if (!completed) interrupted.current = { height: node.getBoundingClientRect().height, opacity: getComputedStyle(node).opacity };
        unregister();
      };
    }
    const previousOpacity = node.style.opacity;
    let animation: Animation | null = null;
    let frame: number | null = null;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (fallback !== null) clearTimeout(fallback);
      if (!exiting) {
        // No height endpoint to release: async content keeps its natural size throughout.
        node.style.opacity = previousOpacity;
        animation?.cancel();
      }
      finishCallback();
    };
    const animate = (keyframes: Keyframe[]) => {
      animation = node.animate(keyframes, {
        duration: TOOL_FOLD_DURATION, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both',
      });
      animation.onfinish = finish;
      fallback = setTimeout(finish, 1500);
    };
    if (exiting) {
      animate([
        { height: `${start?.height ?? node.getBoundingClientRect().height}px`, opacity: start?.opacity ?? '1' },
        { height: '0px', opacity: 0 },
      ]);
    } else {
      // Independent height tweens compress each card while virtua positions siblings
      // using its last measurement. Lay out full-height cards first, then reveal them
      // after ResizeObserver has committed their offsets. Never tween entry geometry.
      const opacity = start?.opacity || '0';
      node.style.opacity = opacity;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          animate([{ opacity }, { opacity: 1 }]);
        });
      });
    }
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (fallback !== null) clearTimeout(fallback);
      if (!finished) interrupted.current = {
        height: node.getBoundingClientRect().height, opacity: getComputedStyle(node).opacity,
      };
      if (animation) {
        animation.onfinish = null;
        animation.cancel();
      }
      node.style.opacity = previousOpacity;
    };
  }, [rowKey, exiting, entering, reveal, revealGroup]);
  return <div ref={ref} data-virtual-row-key={rowKey} data-folding={exiting || undefined}
    aria-hidden={exiting || undefined}
    className={`min-w-0 w-full flow-root ${exiting ? 'overflow-hidden pointer-events-none' : ''}`}>
    <div className={`min-w-0 w-full flow-root ${compact ? '' : 'pb-1'}`}>{children}</div>
  </div>;
}
