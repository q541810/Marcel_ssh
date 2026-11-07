import { useEffect, useState } from 'react';
import { subscribeFontZoomHint } from '@/lib/terminalFontZoom';

/** 最后一次变化后提示停留多久再淡出。 */
const HINT_VISIBLE_MS = 900;

/**
 * 缩放终端字号时浮在终端上方的字号提示（"16px"）。
 * 让用户知道手势生效了、现在多大、有没有撞到上下限。桌面与手机共用，
 * 放进一个 `relative` 的终端区即可，自己不拦截任何点击。
 */
export function TerminalZoomHint() {
  const [size, setSize] = useState<number | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeFontZoomHint((next) => {
      setSize(next);
      setShown(true);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setShown(false), HINT_VISIBLE_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  if (size === null) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-full bg-surface-raised/90 px-3 py-1 text-meta font-medium tabular-nums text-fg shadow-lg ring-1 ring-white/10 backdrop-blur transition-opacity duration-200 ${
        shown ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {size}px
    </div>
  );
}
