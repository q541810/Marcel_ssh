import { useCallback, useEffect, useRef, useState } from 'react';

export type PresencePhase = 'enter' | 'exit';

type AnimationEndLike = { target?: unknown; currentTarget?: unknown };

interface AnimatedPresence {
  /** Keep the element mounted while true (covers the exit animation). */
  mounted: boolean;
  /** Current phase; use to pick the -enter / -exit animation class. */
  phase: PresencePhase;
  /**
   * Pass to the animated element's onAnimationEnd. Unmounts once the exit
   * animation finishes. A timeout fallback also covers cases where the
   * animation never fires (e.g. display:none ancestors). Bubbled child
   * animation events are ignored.
   */
  onAnimationEnd: (e?: AnimationEndLike) => void;
}

/** Fallback in case animationend never fires; slightly above longest exit. */
const EXIT_FALLBACK_MS = 400;

/**
 * Delayed-unmount helper so closing overlays can play an exit animation.
 * For components that own their `open` prop / state.
 *
 * ```tsx
 * const presence = useAnimatedPresence(open);
 * if (!presence.mounted) return null;
 * <div
 *   className={presence.phase === 'exit' ? 'modal-panel-exit' : 'modal-panel-enter'}
 *   onAnimationEnd={presence.onAnimationEnd}
 * />
 * ```
 */
export function useAnimatedPresence(open: boolean): AnimatedPresence {
  const [mounted, setMounted] = useState(open);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setMounted(true);
      return;
    }
    if (!mounted) return;
    // Closing: keep mounted, arm fallback unmount.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setMounted(false);
    }, EXIT_FALLBACK_MS);
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, mounted]);

  const onAnimationEnd = useCallback(
    (e?: AnimationEndLike) => {
      if (open) return;
      // Ignore animation events bubbling up from children.
      if (e && e.target !== e.currentTarget) return;
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setMounted(false);
    },
    [open],
  );

  return {
    mounted,
    phase: open ? 'enter' : 'exit',
    onAnimationEnd,
  };
}

/**
 * For overlays whose parent unmounts them as soon as `onClose` fires
 * (e.g. `{file && <Viewer onClose={() => setFile(null)} />}`): play the exit
 * animation locally first, then invoke the real close callback.
 *
 * ```tsx
 * const { closing, requestClose, onAnimationEnd } = useAnimatedClose(onClose);
 * <div
 *   className={closing ? 'mobile-fullscreen-exit' : 'mobile-fullscreen-enter'}
 *   onAnimationEnd={onAnimationEnd}
 * />
 * ```
 */
export function useAnimatedClose(onClose: () => void): {
  closing: boolean;
  requestClose: () => void;
  onAnimationEnd: (e?: AnimationEndLike) => void;
} {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  const finish = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    closingRef.current = false;
    setClosing(false);
    onCloseRef.current();
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    timerRef.current = setTimeout(finish, EXIT_FALLBACK_MS);
  }, [finish]);

  const onAnimationEnd = useCallback(
    (e?: AnimationEndLike) => {
      if (!closingRef.current) return;
      if (e && e.target !== e.currentTarget) return;
      finish();
    },
    [finish],
  );

  return { closing, requestClose, onAnimationEnd };
}
