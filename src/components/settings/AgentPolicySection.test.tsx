import { describe, it, expect } from 'vitest';
import { preCheckCustomPath } from './AgentPolicySection';

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
