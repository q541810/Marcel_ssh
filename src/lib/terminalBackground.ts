import { DEFAULT_TERMINAL_COLORS, TERMINAL_COLOR_PRESETS } from '@/lib/constants';
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
 * 终端配色跟随应用主题：
 * 当用户未自定义终端颜色（背景/前景仍等于默认暗色）时，浅色主题自动用“亮色”终端配色，
 * 深色主题用“暗色”；用户手动改过配色则尊重用户选择。
 */
export function resolveTerminalThemeColors(
  colors: TerminalColors,
  theme: 'light' | 'dark',
): TerminalColors {
  const d = DEFAULT_TERMINAL_COLORS;
  const isDefaultDark =
    colors?.background === d.background && colors?.foreground === d.foreground;
  if (!isDefaultDark) return colors;
  const preset =
    theme === 'light'
      ? TERMINAL_COLOR_PRESETS.find((p) => p.name === '亮色')
      : TERMINAL_COLOR_PRESETS[0];
  return preset?.colors ?? colors;
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
