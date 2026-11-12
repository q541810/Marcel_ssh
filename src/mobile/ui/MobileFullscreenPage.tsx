import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import { registerBackHandler } from '../backHandler';
import { createPageMotion } from '../pageMotion';
import { useShellFirst } from './useShellFirst';

type ExitAnimationEnd = (e?: { target?: unknown; currentTarget?: unknown }) => void;

interface PageProps {
  /** Page content (header / body / footer), laid out in a column flexbox. */
  children: ReactNode;
  /**
   * Plugin mount point / debugging hook, e.g. `mobile-file-editor`.
   * Mirrors the `data-region` contract used by src/plugins/injection.
   */
  region: string;
  /** Extra classes for the root, mainly the background (default zinc-950). */
  className?: string;
  /**
   * Inline background for pages whose color is only known at runtime (it wins
   * over the class). Layout properties stay owned by the shell.
   */
  backgroundColor?: string;
  /**
   * Android back handler for this page. Omit when the page manages its own
   * back stack (e.g. onboarding steps navigate in-page instead of closing).
   * The callback is read through a ref, so an unstable function does not
   * re-register the layer and reshuffle the back stack order.
   */
  onBack?: () => void;
}

/**
 * How the page is closed. A page has to stay mounted while it flies back to
 * where it came from, so one of the two is required — a page that is simply
 * unmounted by its parent (`{open && <MobileFullscreenPage …>}`) would vanish
 * with no closing motion at all:
 *
 * - `open`: render the page always and pass the flag; the shell keeps it
 *   mounted until the closing motion has played.
 * - `closing` + `onExitAnimationEnd`: for a page whose parent unmounts it on
 *   `onClose` — wire up `useAnimatedClose`.
 */
type Closing =
  | { open: boolean; closing?: undefined; onExitAnimationEnd?: undefined }
  | {
      open?: undefined;
      /** True while the closing motion plays (from `useAnimatedClose`). */
      closing: boolean;
      /** Pass `useAnimatedClose().onAnimationEnd` so the page can unmount afterwards. */
      onExitAnimationEnd: ExitAnimationEnd;
    };

type MobileFullscreenPageProps = PageProps & Closing;

/**
 * Shared shell for mobile full-screen sub-pages (file editor, image viewer,
 * sync pairing, onboarding).
 *
 * Why this exists: these pages portal into `document.body`, so they escape the
 * content-area sizing in `src/mobile/App.tsx`. With `enableEdgeToEdge()` the
 * Android window does not shrink for the soft keyboard, and `html`/`body` are
 * pinned in globals.css, so a naive `fixed inset-0` page fills the full viewport
 * and leaves its lower half buried under the IME.
 *
 * Instead of shrinking the page (which creates a gap that exposes the tab bar
 * underneath), the shell stays `fixed inset-0` and uses `padding-bottom` to push
 * the content area above the keyboard. The page background fills the full
 * viewport, blocking the tab bar.
 */
export default function MobileFullscreenPage({
  children,
  region,
  className = 'bg-surface-sunken',
  backgroundColor,
  open,
  closing: closingProp,
  onExitAnimationEnd,
  onBack,
}: MobileFullscreenPageProps) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // With `open` the shell owns the delayed unmount; otherwise the page's
  // `useAnimatedClose` does and the page counts as open for as long as it is rendered.
  const presence = useAnimatedPresence(open ?? true);
  const closing = open === undefined ? closingProp === true : presence.phase === 'exit';
  const onAnimationEnd = open === undefined ? onExitAnimationEnd : presence.onAnimationEnd;
  const mounted = presence.mounted;

  // Register for as long as the page is open: a stable registration keeps this
  // layer's position in the back stack even when the callback identity changes
  // (e.g. a dirty-state dependency).
  const hasBack = onBack != null && open !== false;
  const rootRef = useRef<HTMLDivElement>(null);
  // Grows out of the control that opened it and flies back into it on close;
  // the back gesture holds it as a card in between (pageMotion.ts).
  const [motion] = useState(() => createPageMotion(() => rootRef.current));
  useEffect(() => {
    if (!hasBack) return;
    return registerBackHandler(() => onBackRef.current?.(), motion.preview);
  }, [hasBack, motion]);

  useLayoutEffect(() => {
    if (!mounted) return;
    if (closing) motion.exit();
    else motion.enter();
  }, [closing, mounted, motion]);
  useEffect(() => {
    if (!mounted) return;
    return () => motion.dispose();
  }, [mounted, motion]);

  // The empty card first, so it starts growing at once; the content right after.
  const showContent = useShellFirst(mounted, rootRef);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={rootRef}
      onAnimationEnd={onAnimationEnd}
      className={`fixed inset-0 z-50 flex flex-col ${className} ${
        closing ? 'mobile-fullscreen-exit' : 'mobile-fullscreen-enter'
      }`}
      style={{
        backgroundColor,
        // Push the content area above the soft keyboard / gesture nav bar
        // instead of shrinking the page (shrinking creates a gap that exposes
        // the pinned tab bar behind). The system navigation bar (3-button
        // nav) is injected as --nav-bar-bottom from MainActivity since
        // Android WebView's env(safe-area-inset-bottom) ignores it.
        paddingBottom:
          'max(env(safe-area-inset-bottom, 0px), var(--nav-bar-bottom, 0px), var(--ime-bottom, 0px))',
        // Portalled pages bypass the shell padding in App.tsx; keep landscape
        // cutouts / rounded corners clear of content.
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
      data-region={region}
    >
      {showContent ? children : null}
    </div>,
    document.body,
  );
}
