import { useEffect, useState } from 'react';

/**
 * 当前设备的像素比。二维码要画在整数个**设备像素**的格子上，缩放比变了（拖到另一块屏、
 * 系统改缩放、浏览器缩放）就得重新算一次，否则格子会重新落到半像素上。
 *
 * 监听两条：`resize`（含浏览器缩放）与 `matchMedia('(resolution: Xdppx)')`（只在 DPR 变化时触发，
 * 拖动窗口跨屏时 `resize` 不一定来）。
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => readDpr());

  useEffect(() => {
    let media: MediaQueryList | null = null;
    let cancelled = false;

    const update = () => {
      if (cancelled) return;
      const next = readDpr();
      setDpr((prev) => (prev === next ? prev : next));
      watch();
    };

    // 每轮重新订阅：DPR 改了，旧 query 就不再触发。
    function watch() {
      media?.removeEventListener('change', update);
      media = null;
      if (cancelled || typeof window.matchMedia !== 'function') return;
      try {
        media = window.matchMedia(`(resolution: ${readDpr()}dppx)`);
        media.addEventListener('change', update);
      } catch {
        media = null;
      }
    }

    watch();
    window.addEventListener('resize', update);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', update);
      media?.removeEventListener('change', update);
    };
  }, []);

  return dpr;
}

export function readDpr(): number {
  const raw = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
