import { DEFAULT_TERMINAL_COLORS, TERMINAL_COLOR_PRESETS } from './constants';
import type { TerminalColors } from './types';

/**
 * The debug light theme is a document-level switch, so xterm needs to use a
 * matching palette even when the user's saved terminal preset is dark.
 * Keep this resolver shared by desktop, mobile, and terminal creation so an
 * existing terminal and a terminal opened while the switch is on agree.
 */
export function isLightThemeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.marcelTheme === 'light';
}

export function getLightTerminalColors(): TerminalColors {
  return TERMINAL_COLOR_PRESETS.find((preset) => preset.name === '亮色')?.colors ?? DEFAULT_TERMINAL_COLORS;
}

export function resolveTerminalColors(
  colors: TerminalColors | null | undefined,
  forceLight = isLightThemeActive(),
): TerminalColors {
  if (forceLight) return getLightTerminalColors();
  return colors ?? DEFAULT_TERMINAL_COLORS;
}
