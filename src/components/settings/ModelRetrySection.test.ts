import { describe, it, expect } from 'vitest';
import { validateRetryHttpStatuses } from '@/lib/llmParams';

describe('validateRetryHttpStatuses', () => {
  it('accepts empty string', () => {
    expect(validateRetryHttpStatuses('')).toBeNull();
  });

  it('accepts whitespace-only as valid', () => {
    expect(validateRetryHttpStatuses('   ')).toBeNull();
  });

  it('accepts single valid code', () => {
    expect(validateRetryHttpStatuses('429')).toBeNull();
  });

  it('accepts multiple codes', () => {
    expect(validateRetryHttpStatuses('408, 429, 502')).toBeNull();
  });

  it('accepts range', () => {
    expect(validateRetryHttpStatuses('500-599')).toBeNull();
  });

  it('accepts mixed codes and ranges', () => {
    expect(validateRetryHttpStatuses('408, 429, 500-599')).toBeNull();
  });

  it('accepts extra whitespace around entries', () => {
    expect(validateRetryHttpStatuses('  429  ,  500  -  599  ')).toBeNull();
  });

  it('rejects non-numeric entry', () => {
    expect(validateRetryHttpStatuses('abc')).toBe('无效状态码: "abc"');
  });

  it('rejects mixed valid and invalid', () => {
    expect(validateRetryHttpStatuses('429, abc')).toBe('无效状态码: "abc"');
  });

  it('rejects code below 100', () => {
    expect(validateRetryHttpStatuses('99')).toBe('状态码超出范围 (100-599): "99"');
  });

  it('rejects code above 599', () => {
    expect(validateRetryHttpStatuses('600')).toBe('状态码超出范围 (100-599): "600"');
  });

  it('rejects range with lo > hi', () => {
    expect(validateRetryHttpStatuses('500-400')).toBe('范围需从小到大: "500-400"');
  });

  it('rejects range where hi exceeds 599', () => {
    expect(validateRetryHttpStatuses('500-600')).toBe('状态码超出范围 (100-599): "500-600"');
  });

  it('rejects range where lo below 100', () => {
    expect(validateRetryHttpStatuses('99-200')).toBe('状态码超出范围 (100-599): "99-200"');
  });

  it('rejects malformed range with extra dashes', () => {
    expect(validateRetryHttpStatuses('500--599')).toBe('无效范围: "500--599"（使用格式 lo-hi）');
  });

  it('rejects empty entry between commas', () => {
    // trailing comma with empty entry
    expect(validateRetryHttpStatuses('429, , 500')).toBeNull();
  });
});
