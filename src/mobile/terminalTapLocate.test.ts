import { describe, it, expect } from 'vitest';
import { resolveTapLocateSequence } from './terminalTapLocate';

describe('resolveTapLocateSequence', () => {
  it('moves right by the column delta on the cursor row', () => {
    expect(resolveTapLocateSequence(2, 1, 10, { col: 5, line: 11 })).toBe(
      '\x1b[C'.repeat(3),
    );
  });

  it('moves left by the column delta', () => {
    expect(resolveTapLocateSequence(8, 0, 3, { col: 5, line: 3 })).toBe(
      '\x1b[D'.repeat(3),
    );
  });

  it('returns null when tapping the cursor cell itself', () => {
    expect(resolveTapLocateSequence(4, 2, 0, { col: 4, line: 2 })).toBeNull();
  });

  it('returns null above the cursor row (shell history risk)', () => {
    expect(resolveTapLocateSequence(4, 2, 0, { col: 4, line: 1 })).toBeNull();
  });

  it('returns null below the cursor row (program bindings risk)', () => {
    expect(resolveTapLocateSequence(4, 2, 0, { col: 4, line: 3 })).toBeNull();
  });

  it('accounts for the viewport scroll offset', () => {
    // Cursor visual row 2 sits on absolute line 12 when scrolled by 10.
    expect(resolveTapLocateSequence(0, 2, 10, { col: 1, line: 12 })).toBe(
      '\x1b[C',
    );
    // Same visual row but different absolute line → not the cursor row.
    expect(resolveTapLocateSequence(0, 2, 10, { col: 1, line: 11 })).toBeNull();
  });

  it('moves right across many columns (long command start fix)', () => {
    const seq = resolveTapLocateSequence(60, 0, 0, { col: 0, line: 0 });
    expect(seq).toBe('\x1b[D'.repeat(60));
  });
});
