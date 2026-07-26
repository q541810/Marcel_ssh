import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerBackHandler } from '../backHandler';

interface MobileFullscreenPageProps {
  /** Page content (header / body / footer), laid out in a column flexbox. */
  children: ReactNode;
  /**
   * Plugin mount point / debugging hook, e.g. `mobile-file-editor`.
   * Mirrors the `data-region` contract used by src/plugins/injection.
   */
  region: string;
  /** Extra classes for the root, mainly the background (default zinc-950). */
  className?: string;
  /** True while the exit animation plays (from `useAnimatedClose`). */
  closing?: boolean;
  /** Pass `useAnimatedClose().onAnimationEnd` so the exit can unmount. */
  onExitAnimationEnd?: (e?: {
    target?: unknown;
    currentTarget?: unknown;
  }) => void;
  /**
   * Android back handler for this page. Omit when the page manages its own
   * back stack (e.g. onboarding steps navigate in-page instead of closing).
   * The callback is read through a ref, so an unstable function does not
   * re-register the layer and reshuffle the back stack order.
   */
  onBack?: () => void;
}

/**
 * Shared shell for mobile full-screen sub-pages (file editor, image viewer,
 * sync pairing, onboarding).
 *
 * Why this exists: these pages portal into `document.body`, so they escape the
 * content-area sizing in `src/mobile/App.tsx`. With `enableEdgeToEdge()` the
 * Android window does not shrink for the soft keyboard, and `html`/`body` are
 * pinned in globals.css, so a naive `fixed inset-0` page keeps the full window
 * height and leaves its lower part (and the text caret) buried under the IME.
 *
 * The shell reserves the keyboard height by pulling the page bottom up with
 * `--ime-bottom` (published by MainActivity), matching what App.tsx does for
 * the tab content area. Full-screen pages have no pinned tab bar, so the whole
 * page may shrink.
 */
export default function MobileFullscreenPage({
  children,
  region,
  className = 'bg-zinc-950',
  closing = false,
  onExitAnimationEnd,
  onBack,
}: MobileFullscreenPageProps) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // Register once per mount: the page is only rendered while open, and a
  // stable registration keeps this layer's position in the back stack even
  // when the callback identity changes (e.g. a dirty-state dependency).
  const hasBack = onBack != null;
  useEffect(() => {
    if (!hasBack) return;
    return registerBackHandler(() => onBackRef.current?.());
  }, [hasBack]);

  return createPortal(
    <div
      onAnimationEnd={onExitAnimationEnd}
      className={`fixed inset-x-0 top-0 z-50 flex flex-col ${className} ${
        closing ? 'mobile-fullscreen-exit' : 'mobile-fullscreen-enter'
      }`}
      style={{
        // Give the soft keyboard its space instead of drawing underneath it.
        bottom: 'var(--ime-bottom, 0px)',
        // Portalled pages bypass the shell padding in App.tsx; keep landscape
        // cutouts / rounded corners clear of content.
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
      data-region={region}
    >
      {children}
    </div>,
    document.body,
  );
}
