import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_COLORS } from './constants';
import { resolveTerminalColors } from './terminalTheme';

describe('resolveTerminalColors', () => {
  it('uses the readable light palette when the debug theme is active', () => {
    const colors = resolveTerminalColors(DEFAULT_TERMINAL_COLORS, true);

    expect(colors.background).toBe('#ffffff');
    expect(colors.foreground).toBe('#18181b');
    expect(colors.selectionForeground).toBe('#1e1b4b');
    expect(colors.white).toBe('#374151');
    expect(colors.brightWhite).toBe('#111827');
    expect(colors.brightYellow).toBe('#854d0e');
  });

  it('preserves the selected user palette when light mode is inactive', () => {
    const colors = resolveTerminalColors(DEFAULT_TERMINAL_COLORS, false);

    expect(colors).toBe(DEFAULT_TERMINAL_COLORS);
  });
});
