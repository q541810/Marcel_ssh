import { describe, it, expect } from 'vitest';
import { contextWindowHint } from './contextWindowHints';

describe('contextWindowHint', () => {
  it('0 / 未设置 → 无提示', () => {
    expect(contextWindowHint(0)).toBeUndefined();
    expect(contextWindowHint(undefined)).toBeUndefined();
  });

  it('正常区间（150k ~ 10M 含边界）→ 无提示', () => {
    expect(contextWindowHint(150_000)).toBeUndefined();
    expect(contextWindowHint(1_000_000)).toBeUndefined();
    expect(contextWindowHint(10_000_000)).toBeUndefined();
  });

  it('小于 15 万（不含 0）→ 过小提示（推荐用 0）', () => {
    expect(contextWindowHint(1000)).toContain('过小');
    expect(contextWindowHint(149_999)).toContain('推荐您使用0');
  });

  it('大于 1000 万 → 过大提示（不阻止）', () => {
    expect(contextWindowHint(10_000_001)).toContain('极少触发');
    // 未来超大窗口模型（如 1B tokens）允许配置，仅提示
    expect(contextWindowHint(1_000_000_000)).toContain('极少触发');
  });
});
