import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useIsomorphicLayoutEffect } from './useStickyFollow';

/** A manual disclosure pins its header, until the reader scrolls or explicitly follows. */
export function useFoldScrollAnchor(
  root: RefObject<HTMLElement | null>, viewport: RefObject<HTMLElement | null>,
  revision: unknown, visible: boolean,
) {
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const frame = useRef<number | null>(null);
  const cancel = useCallback(() => {
    anchor.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const restore = useCallback(() => {
    const node = viewport.current;
    const current = anchor.current;
    if (!node || !current || !visible) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-virtual-row-key="${CSS.escape(current.key)}"]`);
    if (!row || row.hasAttribute('data-virtual-row-hidden')) { cancel(); return; }
    const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - current.offset;
    if (Math.abs(delta) > 0.5) node.scrollTop += delta;
  }, [root, viewport, visible, cancel]);
  const schedule = useCallback(() => {
    if (!anchor.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; restore(); });
  }, [restore]);
  const capture = useCallback((target: Element) => {
    const row = target.closest<HTMLElement>('[data-virtual-row-key]');
    const node = viewport.current;
    if (!row?.dataset.virtualRowKey || !node) return;
    anchor.current = { key: row.dataset.virtualRowKey,
      offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top };
  }, [viewport]);
  useIsomorphicLayoutEffect(() => { restore(); schedule(); }, [revision, restore, schedule]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || !visible) return;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (root.current) observer?.observe(root.current);
    node.addEventListener('scroll', schedule, { passive: true });
    node.addEventListener('wheel', cancel, { passive: true });
    node.addEventListener('touchstart', cancel, { passive: true });
    node.addEventListener('pointerdown', cancel, { passive: true });
    node.addEventListener('keydown', cancel);
    return () => {
      observer?.disconnect();
      node.removeEventListener('scroll', schedule);
      node.removeEventListener('wheel', cancel);
      node.removeEventListener('touchstart', cancel);
      node.removeEventListener('pointerdown', cancel);
      node.removeEventListener('keydown', cancel);
      cancel();
    };
  }, [root, viewport, visible, schedule, cancel]);
  return { capture, cancel, anchorKey: anchor.current?.key };
}
