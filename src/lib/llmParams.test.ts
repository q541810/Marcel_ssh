import { describe, it, expect } from 'vitest';
import { contextWindowToText, effortsToText, textToContextWindow, textToEfforts } from './llmParams';

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

describe('contextWindowToText / textToContextWindow', () => {
  it('0 / 未设置显示为空，正值原样展示', () => {
    expect(contextWindowToText(0)).toBe('');
    expect(contextWindowToText(undefined)).toBe('');
    expect(contextWindowToText(1048576)).toBe('1048576');
  });

  it('空串按 0 处理，数字文本正常解析', () => {
    expect(textToContextWindow('')).toBe(0);
    expect(textToContextWindow('   ')).toBe(0);
    expect(textToContextWindow('128000')).toBe(128000);
  });
});
