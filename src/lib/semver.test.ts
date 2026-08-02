import { describe, expect, it } from 'vitest';
import { satisfiesMinVersion } from './semver';

describe('satisfiesMinVersion', () => {
  it('satisfies when no min version declared (no-op path guarded by caller)', () => {
    // Caller skips the check when minAppVersion is undefined; here we only
    // verify the comparison itself.
    expect(satisfiesMinVersion('1.7.0', '0.0.1')).toBe(true);
  });

  it('equal versions satisfy', () => {
    expect(satisfiesMinVersion('1.7.0', '1.7.0')).toBe(true);
  });

  it('newer app version satisfies', () => {
    expect(satisfiesMinVersion('1.8.0', '1.7.0')).toBe(true);
    expect(satisfiesMinVersion('2.0.0', '1.99.99')).toBe(true);
  });

  it('older app version does not satisfy', () => {
    expect(satisfiesMinVersion('1.6.9', '1.7.0')).toBe(false);
    expect(satisfiesMinVersion('1.7.0', '2.0.0')).toBe(false);
  });

  it('missing segments count as zero', () => {
    expect(satisfiesMinVersion('1.7', '1.7.0')).toBe(true);
    expect(satisfiesMinVersion('1.7.0', '1.7')).toBe(true);
    expect(satisfiesMinVersion('1.6', '1.7.0')).toBe(false);
    expect(satisfiesMinVersion('1.7', '1.6.5')).toBe(true);
  });

  it('malformed versions are treated as not satisfied', () => {
    expect(satisfiesMinVersion('1.7.0', 'abc')).toBe(false);
    expect(satisfiesMinVersion('abc', '1.0.0')).toBe(false);
    expect(satisfiesMinVersion('1.x.0', '1.0.0')).toBe(false);
    expect(satisfiesMinVersion('1.7.0', '')).toBe(false);
  });

  it('rejects scientific notation and hex (mirrors Rust parse::<u64>)', () => {
    expect(satisfiesMinVersion('1.7.0', '1e2')).toBe(false);
    expect(satisfiesMinVersion('1e2', '1.0.0')).toBe(false);
    expect(satisfiesMinVersion('1.7.0', '0x10')).toBe(false);
  });

  it('handles leading/trailing whitespace', () => {
    expect(satisfiesMinVersion(' 1.7.0 ', '1.7')).toBe(true);
  });
});
