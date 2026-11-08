import { useMemo } from 'react';
import { useDevicePixelRatio } from '@/hooks/useDevicePixelRatio';
import { buildQrMatrix, qrRenderPlan, scaledPath } from './qrMatrix';

/**
 * 二维码。**永远是白底黑块**，不跟深浅色主题走：扫码器认的是"深色块 + 浅色底"的对比，
 * 暗色主题下把它画成"白块黑底"很多相机直接扫不出来。外围的白边就是规范里的静区。
 *
 * 尺寸按 [`qrRenderPlan`] 算：每格恰好落在整数个**设备像素**上，且不小于 3 个。
 * 这是能不能扫出来的关键——按固定的 CSS 尺寸缩放（旧做法）会让同步码这种长内容
 * 每格只剩 1 个多像素、格子宽窄不一，手机怎么对都对不上。
 *
 * `maxSize` 是可用宽度（CSS px）。**装不下就返回 null**，不画一张扫不出来的码：
 * 用户对着那种码反复扫不出来，只会得出"这功能坏了"的结论，比什么都不显示更糟。
 * 调用方拿到 null 要自己给替代方案——放大弹层、或者一句"复制同步码"。
 */
export function QrCode({
  text,
  maxSize,
  label,
  className = '',
}: {
  text: string;
  maxSize: number;
  label: string;
  className?: string;
}) {
  const dpr = useDevicePixelRatio();
  const matrix = useMemo(() => buildQrMatrix(text), [text]);
  const plan = useMemo(
    () => (matrix && maxSize > 0 ? qrRenderPlan(matrix, maxSize, dpr) : null),
    [matrix, maxSize, dpr],
  );
  const path = useMemo(
    () => (matrix && plan ? scaledPath(matrix, plan.modulePx) : null),
    [matrix, plan],
  );
  if (!matrix || !plan || !plan.fits || path === null) return null;
  // viewBox 走**设备像素**坐标系：格子边界全在整数上，渲染器没有四舍五入的余地。
  const device = matrix.size * plan.modulePx;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${device} ${device}`}
      width={plan.cssSize}
      height={plan.cssSize}
      shapeRendering="crispEdges"
      // 不要圆角：静区必须是一条干净的白边，圆角会把定位图案外侧的白边啃掉。
      className={`block bg-white ${className}`}
    >
      <rect width={device} height={device} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
