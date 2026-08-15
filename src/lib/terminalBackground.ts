import type { TerminalColors } from '@/lib/types';

/** Convert a #rgb / #rrggbb color to an rgba() string. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  if (Number.isNaN(num) || full.length !== 6) return `rgba(0,0,0,${alpha})`;
  return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
}

/**
 * 亚克力开启时，让 xterm 背景半透明，透出下方的毛玻璃/桌面。
 */
export function resolveTerminalBackground(
  colors: TerminalColors,
  acrylicOn: boolean,
): TerminalColors {
  if (!acrylicOn) return colors;
  return { ...colors, background: hexToRgba(colors.background, 0.62) };
}
