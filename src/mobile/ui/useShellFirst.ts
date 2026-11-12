import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { afterFrame, prefersReducedMotion } from '../motion';
import { noteContent } from '../motionLog';

/**
 * Content that lands later than this after the page started to grow is
 * faded in; earlier, the card is still small and coming up, and the content
 * simply appears (fading every page would make ordinary ones look washed out).
 */
export const LATE_CONTENT_MS = 100;
export const CONTENT_FADE_MS = 180;

/**
 * Shell first, content right after — for the page shells
 * (`MobileFullscreenPage`, `MobileStackPage`).
 *
 * Building a page's content (its header, rows, switches) can take a phone
 * hundreds of ms, and nothing moves until it is done. So the first commit is
 * only the empty card: it costs next to nothing, and the page starts to grow
 * out of the row at once. The content is built after that frame is out;
 * the growing runs on the compositor meanwhile and does not wait for it.
 * Content that arrives once the card is already big fades in, in place
 * (opacity only — nothing moves).
 *
 * Without Web Animations (tests) or with reduced motion there is no growing to
 * get ahead of: the content renders with the shell, as before.
 *
 * Returns whether to render the content now. Resets each time the page
 * unmounts, so every opening goes shell-first.
 */
export function useShellFirst(mounted: boolean, rootRef: RefObject<HTMLElement | null>): boolean {
  const [deferring] = useState(
    () => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function' && !prefersReducedMotion(),
  );
  const [ready, setReady] = useState(!deferring);
  const shownAt = useRef(0);
  const faded = useRef(false);

  // Unmounted (the `open` shells stay alive while closed): next opening starts over.
  if (!mounted && ready && deferring) setReady(false);

  useEffect(() => {
    if (!mounted || ready) return;
    shownAt.current = performance.now();
    faded.current = false;
    // After the frame that starts the growing has been handed over.
    return afterFrame(() => setReady(true), 120);
  }, [mounted, ready]);

  // Before paint, so late content never shows a frame at full opacity first.
  useLayoutEffect(() => {
    if (!mounted || !ready || !deferring || faded.current) return;
    faded.current = true;
    const root = rootRef.current;
    if (!root) return;
    const late = performance.now() - shownAt.current > LATE_CONTENT_MS;
    noteContent(root, late);
    if (!late) return;
    for (const child of Array.from(root.children)) {
      if (child.hasAttribute('data-back-shadow')) continue;
      child.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: CONTENT_FADE_MS,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
      });
    }
  }, [mounted, ready, deferring, rootRef]);

  return ready;
}
