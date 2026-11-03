import { describe, expect, it } from 'vitest';
import {
  headersToPairs,
  pairsToHeaders,
  isReservedHeader,
  type HeaderPair,
} from '@/lib/channelHeaders';

describe('headersToPairs', () => {
  it('空对象得到空列表', () => {
    expect(headersToPairs({})).toEqual([]);
  });

  it('按 key 排序，保持稳定', () => {
    const pairs = headersToPairs({ 'x-z': '2', 'x-a': '1' });
    expect(pairs).toEqual([
      { name: 'x-a', value: '1' },
      { name: 'x-z', value: '2' },
    ]);
  });
});

describe('pairsToHeaders', () => {
  it('丢掉空名字的行', () => {
    const pairs: HeaderPair[] = [
      { name: 'x-a', value: '1' },
      { name: '   ', value: 'ignored' },
      { name: '', value: 'also-ignored' },
    ];
    expect(pairsToHeaders(pairs)).toEqual({ 'x-a': '1' });
  });

  it('名字两端空白被裁掉', () => {
    expect(pairsToHeaders([{ name: '  x-pad  ', value: 'v' }])).toEqual({ 'x-pad': 'v' });
  });

  it('同名的后者覆盖前者（与后端 insert 语义一致）', () => {
    const pairs: HeaderPair[] = [
      { name: 'x-a', value: 'first' },
      { name: 'x-a', value: 'second' },
    ];
    expect(pairsToHeaders(pairs)).toEqual({ 'x-a': 'second' });
  });

  it('保留空值（用户可能想发一个空头）', () => {
    expect(pairsToHeaders([{ name: 'x-a', value: '' }])).toEqual({ 'x-a': '' });
  });

  it('往返不丢信息', () => {
    const src = { 'user-agent': 'Marcel/1.0', 'x-opencode-session': 'uuid-1' };
    expect(pairsToHeaders(headersToPairs(src))).toEqual(src);
  });
});

describe('isReservedHeader', () => {
  it('识别受保护的协议头（大小写与空白不敏感）', () => {
    expect(isReservedHeader('content-type')).toBe(true);
    expect(isReservedHeader('Content-Type')).toBe(true);
    expect(isReservedHeader('  authorization  ')).toBe(true);
    expect(isReservedHeader('content-length')).toBe(true);
  });

  it('普通头不算受保护', () => {
    expect(isReservedHeader('user-agent')).toBe(false);
    expect(isReservedHeader('x-opencode-session')).toBe(false);
  });
});
