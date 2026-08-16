import { describe, it, expect } from 'vitest';
import {
  bufferCoordsFromPoint,
  resolveTapLocateSequence,
} from './terminalCursorLocate';

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

  it('returns null when pointing at the cursor cell itself', () => {
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

  it('moves left across many columns (long command start fix)', () => {
    expect(resolveTapLocateSequence(60, 0, 0, { col: 0, line: 0 })).toBe(
      '\x1b[D'.repeat(60),
    );
  });
});

describe('bufferCoordsFromPoint', () => {
  const screen = { left: 0, top: 0, width: 800, height: 240 };
  const cols = 80;
  const rows = 24;

  it('maps a client point to cell coords', () => {
    // cellW=10, cellH=10 → (125, 55) = col 12, row 5
    expect(bufferCoordsFromPoint(125, 55, screen, cols, rows, 0)).toEqual({
      col: 12,
      line: 5,
    });
  });

  it('returns null outside the screen', () => {
    expect(bufferCoordsFromPoint(-5, 10, screen, cols, rows, 0)).toBeNull();
    expect(bufferCoordsFromPoint(10, 9999, screen, cols, rows, 0)).toBeNull();
  });

  it('clamps to the screen edge when requested', () => {
    expect(
      bufferCoordsFromPoint(9999, 9999, screen, cols, rows, 0, { clamp: true }),
    ).toEqual({ col: 79, line: 23 });
  });

  it('adds the viewport offset to the line', () => {
    expect(bufferCoordsFromPoint(55, 55, screen, cols, rows, 10)).toEqual({
      col: 5,
      line: 15,
    });
  });

  it('returns null for degenerate screens', () => {
    expect(
      bufferCoordsFromPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }, cols, rows, 0),
    ).toBeNull();
  });
});
