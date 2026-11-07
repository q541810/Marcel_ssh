import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import { registerBackHandler } from '../backHandler';
import { createPageMotion } from '../pageMotion';

interface MobileStackPageProps {
  /** Shown while true; on false the page plays its exit animation, then unmounts. */
  open: boolean;
  /**
   * Back (gesture, button) for this page. Read through a ref, so an unstable
   * function does not re-register the layer and reshuffle the back stack.
   */
  onBack: () => void;
  /**
   * The screen this page is stacked on (stays mounted underneath). The
   * predictive-back gesture shrinks this page into a card and brings that
   * screen forward behind it.
   */
  underlay: () => HTMLElement | null;
  /**
   * Whether this page takes part in the Android back stack right now — false
   * while its tab is hidden (tab keep-alive), so a hidden tab never swallows
   * the gesture.
   */
  backEnabled?: boolean;
  children: ReactNode;
  /** Extra classes for the root, mainly the background (default zinc-950). */
  className?: string;
}

/**
 * A sub-page stacked *inside* a tab (settings category, a second level under
 * it): it covers its parent screen instead of replacing it, so the parent keeps
 * its state and scroll position, and the page can grow out of the row that
 * opened it and fly back into it — on the back gesture, the back button or any
 * other close (pageMotion.ts), exactly like a full-screen page
 * (`MobileFullscreenPage`), just scoped to the tab.
 *
 * The parent must be a positioned box that both this page and `underlay` fill
 * (`absolute inset-0`); the page sits on top at `z-10`.
 */
export default function MobileStackPage({
  open,
  onBack,
  underlay,
  backEnabled = true,
  children,
  className = 'bg-surface-sunken',
}: MobileStackPageProps) {
  const presence = useAnimatedPresence(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const underlayRef = useRef(underlay);
  underlayRef.current = underlay;

  const [motion] = useState(() =>
    createPageMotion(
      () => rootRef.current,
      () => underlayRef.current(),
    ),
  );

  const registered = open && backEnabled;
  useEffect(() => {
    if (!registered) return;
    return registerBackHandler(() => onBackRef.current(), motion.preview);
  }, [registered, motion]);

  // Open: grow out of the row that was tapped. Close: fly back into it. Runs
  // before paint, so the CSS entrance never shows a frame.
  const mounted = presence.mounted;
  useLayoutEffect(() => {
    if (!mounted) return;
    if (open) motion.enter();
    else motion.exit();
  }, [open, mounted, motion]);
  useEffect(() => {
    if (!mounted) return;
    return () => motion.dispose();
  }, [mounted, motion]);

  if (!presence.mounted) return null;
  return (
    <div
      ref={rootRef}
      onAnimationEnd={presence.onAnimationEnd}
      className={`absolute inset-0 z-10 flex min-h-0 flex-col ${className} ${
        presence.phase === 'exit' ? 'mobile-fullscreen-exit' : 'mobile-fullscreen-enter'
      }`}
    >
      {children}
    </div>
  );
}
