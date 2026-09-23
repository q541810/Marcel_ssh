import { describe, it, expect } from 'vitest';
import { needsUrlScheme, preCheckCustomPath } from './AgentPolicySection';

describe('preCheckCustomPath', () => {
  it('returns null for empty string', () => {
    expect(preCheckCustomPath('', [])).toBeNull();
    expect(preCheckCustomPath('   ', [])).toBeNull();
  });

  it('returns error for duplicate path', () => {
    expect(preCheckCustomPath('/etc', ['/etc', '/var'])).toBe('路径已存在：/etc');
    expect(preCheckCustomPath('/a', ['/a', '/b'])).toContain('路径已存在');
  });

  it('returns null for new unique path', () => {
    expect(preCheckCustomPath('/new', ['/existing'])).toBeNull();
    expect(preCheckCustomPath('/home/user/.ssh', [])).toBeNull();
    expect(preCheckCustomPath('/var/log', ['/a', '/b'])).toBeNull();
  });

  it('returns null for the same path with different casing (case-sensitive)', () => {
    expect(preCheckCustomPath('/Etc', ['/etc'])).toBeNull();
    expect(preCheckCustomPath('/HOME', ['/home'])).toBeNull();
  });
});

describe('needsUrlScheme', () => {
  it('空值不报警——空 = 用官方地址，是合法状态', () => {
    expect(needsUrlScheme('')).toBe(false);
    expect(needsUrlScheme('   ')).toBe(false);
    expect(needsUrlScheme(undefined)).toBe(false);
  });

  it('带 http/https 的地址不算可疑', () => {
    expect(needsUrlScheme('https://api.typesafe.ai')).toBe(false);
    expect(needsUrlScheme('http://127.0.0.1:8787')).toBe(false);
    expect(needsUrlScheme('  https://gw.example.com/api  ')).toBe(false);
    // 大小写不敏感：HTTPS:// 也是合法输入。
    expect(needsUrlScheme('HTTPS://gw.example.com')).toBe(false);
  });

  it('缺协议头的地址报警（照这样请求会失败并拦下每条 bash）', () => {
    expect(needsUrlScheme('api.typesafe.ai')).toBe(true);
    expect(needsUrlScheme('jev-gw.corp.example.com')).toBe(true);
    expect(needsUrlScheme('127.0.0.1:8787')).toBe(true);
    // 其它协议也不算——只认 http/https。
    expect(needsUrlScheme('ftp://gw.example.com')).toBe(true);
  });
});
