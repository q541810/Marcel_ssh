import { describe, it, expect } from 'vitest';
import { effortsToText, textToEfforts } from './llmParams';

describe('effortsToText / textToEfforts', () => {
  it('round-trips a normal list', () => {
    const list = ['low', 'high', 'max'];
    expect(textToEfforts(effortsToText(list))).toEqual(list);
  });

  it('empty/undefined collapses to empty text and empty list', () => {
    expect(effortsToText(undefined)).toBe('');
    expect(effortsToText([])).toBe('');
    expect(textToEfforts('')).toEqual([]);
    expect(textToEfforts('   \n \n')).toEqual([]);
  });

  it('splits by line, trims whitespace, drops empties and duplicates (keeps first order)', () => {
    expect(textToEfforts('  low \nhigh\n\n high\nmax\n')).toEqual(['low', 'high', 'max']);
  });

  it('handles CRLF line endings', () => {
    expect(textToEfforts('low\r\nmedium\r\nhigh')).toEqual(['low', 'medium', 'high']);
  });
});
