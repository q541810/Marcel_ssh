import { describe, it, expect } from 'vitest';
import { isExposedBind, isValidPort, sanitizePortInput } from './mcpServerUi';

describe('isExposedBind', () => {
  it('treats loopback forms as NOT exposed', () => {
    // 这三个都是「仅本机」，不该报暴露警告
    expect(isExposedBind('127.0.0.1')).toBe(false);
    expect(isExposedBind('::1')).toBe(false);
    expect(isExposedBind('localhost')).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(isExposedBind('  127.0.0.1  ')).toBe(false);
    expect(isExposedBind(' 0.0.0.0 ')).toBe(true);
  });

  it('flags anything else as exposed', () => {
    // 这些都会让局域网/公网上的其他机器连得上——必须亮红
    expect(isExposedBind('0.0.0.0')).toBe(true);
    expect(isExposedBind('192.168.1.10')).toBe(true);
    expect(isExposedBind('::')).toBe(true);
    expect(isExposedBind('10.0.0.5')).toBe(true);
  });

  it('treats empty as not exposed (nothing to warn about yet)', () => {
    // 输入框被清空的中间态：还没填，不该先吓用户一跳
    expect(isExposedBind('')).toBe(false);
    expect(isExposedBind('   ')).toBe(false);
  });

  it('does not treat a lookalike address as loopback', () => {
    // 防「看起来像回环」的误判：127.0.0.2 是回环段但不等价，
    // 这里保守认为非 127.0.0.1 就提示——宁可多提示一次
    expect(isExposedBind('127.0.0.2')).toBe(true);
    expect(isExposedBind('127.0.0.1.evil.com')).toBe(true);
  });
});

describe('sanitizePortInput', () => {
  it('keeps digits', () => {
    expect(sanitizePortInput('8765')).toBe(8765);
  });

  it('strips non-digits instead of producing NaN', () => {
    // `Number('12a')` 会给 NaN，NaN 传进后端就是一句看不懂的错误
    expect(sanitizePortInput('12a')).toBe(12);
    expect(sanitizePortInput(' 8 7 6 5 ')).toBe(8765);
    expect(sanitizePortInput('abc')).toBe(0);
  });

  it('empty input becomes 0 (which isValidPort rejects)', () => {
    expect(sanitizePortInput('')).toBe(0);
    expect(isValidPort(sanitizePortInput(''))).toBe(false);
  });

  it('strips minus and dot rather than parsing a negative/float', () => {
    expect(sanitizePortInput('-1')).toBe(1);
    expect(sanitizePortInput('80.5')).toBe(805);
  });
});

describe('isValidPort', () => {
  it('accepts the valid range', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(8765)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it('rejects 0 and out-of-range', () => {
    // 0 与 >65535 后端都会拒绝（u16 且非 0），前端先挡住省一次往返
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidPort(80.5)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});
