import { describe, it, expect } from 'vitest';
import {
  validateExtraBodyJson,
  extraBodyToText,
  textToExtraBody,
} from '@/lib/llmParams';

describe('validateExtraBodyJson', () => {
  it('accepts empty string (not set)', () => {
    expect(validateExtraBodyJson('')).toBeNull();
  });

  it('accepts whitespace-only as not set', () => {
    expect(validateExtraBodyJson('   \n  ')).toBeNull();
  });

  it('accepts empty object {}', () => {
    expect(validateExtraBodyJson('{}')).toBeNull();
  });

  it('accepts object with keys', () => {
    expect(validateExtraBodyJson('{"thinking":{"type":"enabled"}}')).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(validateExtraBodyJson('{ broken')).toMatch(/JSON 解析失败/);
  });

  it('rejects null literal', () => {
    expect(validateExtraBodyJson('null')).toMatch(/必须是 JSON 对象/);
  });

  it('rejects array', () => {
    expect(validateExtraBodyJson('[1,2,3]')).toMatch(/必须是 JSON 对象/);
  });

  it('rejects primitive', () => {
    expect(validateExtraBodyJson('"hello"')).toMatch(/必须是 JSON 对象/);
    expect(validateExtraBodyJson('42')).toMatch(/必须是 JSON 对象/);
  });
});

describe('extraBodyToText', () => {
  it('null → empty string (not set)', () => {
    expect(extraBodyToText(null)).toBe('');
  });

  it('undefined → empty string (not set)', () => {
    expect(extraBodyToText(undefined)).toBe('');
  });

  it('{} → "{}" (preserve empty object — backend treats as no-op, validator accepts as valid)', () => {
    expect(extraBodyToText({})).toBe('{}');
  });

  it('object with keys → pretty JSON', () => {
    expect(extraBodyToText({ top_p: 0.9 })).toBe('{\n  "top_p": 0.9\n}');
  });
});

describe('textToExtraBody', () => {
  it('empty string → null (not set)', () => {
    expect(textToExtraBody('')).toBeNull();
  });

  it('whitespace → null (not set)', () => {
    expect(textToExtraBody('   \n  ')).toBeNull();
  });

  it('{} → {} (preserve empty object)', () => {
    expect(textToExtraBody('{}')).toEqual({});
  });

  it('object with keys → parsed', () => {
    expect(textToExtraBody('{"a":1}')).toEqual({ a: 1 });
  });

  it('null literal → null (normalized to not set)', () => {
    expect(textToExtraBody('null')).toBeNull();
  });

  it('array → null (rejected, not representable in store)', () => {
    expect(textToExtraBody('[1,2]')).toBeNull();
  });
});

describe('round-trip (text → store → text) preserves empty object', () => {
  it('{} survives a full text ↔ store round-trip (regression: was being collapsed to "")', () => {
    const text = textToExtraBody('{}');
    expect(text).toEqual({});
    const back = extraBodyToText(text);
    expect(back).toBe('{}');
  });
});
