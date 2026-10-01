import { useCallback, useRef } from "react";

const REQUIRED_TAPS = 7;
const TAP_INTERVAL_MS = 1200;

/** Hidden debug entry shared by desktop and mobile version buttons. */
export function useDebugUnlock(onUnlock: () => void): () => void {
  const tapsRef = useRef({ count: 0, lastTap: null as number | null });

  return useCallback(() => {
    const taps = tapsRef.current;
    const now = Date.now();
    taps.count =
      taps.lastTap == null || now - taps.lastTap >= TAP_INTERVAL_MS
        ? 1
        : taps.count + 1;
    taps.lastTap = now;
    if (taps.count < REQUIRED_TAPS) return;

    taps.count = 0;
    taps.lastTap = null;
    onUnlock();
  }, [onUnlock]);
}
