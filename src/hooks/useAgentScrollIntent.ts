import { useEffect, useRef, type RefObject } from 'react';

/** Virtual height corrections emit scroll too; only user input may release sticky follow. */
export function useAgentScrollIntent(container: RefObject<HTMLElement | null>, visible = true) {
  const userScrolling = useRef(false);
  useEffect(() => {
    const node = container.current;
    if (!node || !visible) return;
    const mark = () => { userScrolling.current = true; };
    const pointer = (event: Event) => {
      // Clicking a disclosure is not a scroll; later virtual size corrections must not
      // reinterpret that click as permission to change the transcript's follow state.
      if ((event.target as Element | null)?.closest?.('button, a, input, textarea, select, [role="button"]')) return;
      mark();
    };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) mark();
    };
    node.addEventListener('wheel', mark, { passive: true });
    node.addEventListener('pointerdown', pointer, { passive: true });
    node.addEventListener('touchstart', mark, { passive: true });
    node.addEventListener('keydown', key);
    return () => {
      node.removeEventListener('wheel', mark);
      node.removeEventListener('pointerdown', pointer);
      node.removeEventListener('touchstart', mark);
      node.removeEventListener('keydown', key);
    };
  }, [container, visible]);
  return userScrolling;
}
