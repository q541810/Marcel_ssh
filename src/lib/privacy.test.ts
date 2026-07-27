import { describe, it, expect } from 'vitest';
import {
  MASKED_HOST,
  MASKED_PORT,
  maskHost,
  maskPort,
  formatAddress,
  formatConnLabel,
  formatNameWithAddress,
} from '@/lib/privacy';

describe('maskHost', () => {
  it('returns the original host when privacy mode is off', () => {
    expect(maskHost('192.168.1.1', false)).toBe('192.168.1.1');
    expect(maskHost('example.com', false)).toBe('example.com');
  });

  it('returns the masked constant when privacy mode is on', () => {
    expect(maskHost('192.168.1.1', true)).toBe(MASKED_HOST);
    expect(maskHost('example.com', true)).toBe(MASKED_HOST);
  });
});

describe('maskPort', () => {
  it('returns the original port when privacy mode is off', () => {
    expect(maskPort(22, false)).toBe(22);
    expect(maskPort(2222, false)).toBe(2222);
  });

  it('returns the masked constant when privacy mode is on', () => {
    expect(maskPort(22, true)).toBe(MASKED_PORT);
    expect(maskPort(2222, true)).toBe(MASKED_PORT);
  });
});

describe('formatAddress', () => {
  it('renders host:port when privacy mode is off', () => {
    expect(formatAddress('10.0.0.1', 22, false)).toBe('10.0.0.1:22');
  });

  it('renders only host when port is null and privacy mode is off', () => {
    expect(formatAddress('10.0.0.1', null, false)).toBe('10.0.0.1');
  });

  it('renders masked host:port when privacy mode is on', () => {
    expect(formatAddress('10.0.0.1', 22, true)).toBe(`${MASKED_HOST}:${MASKED_PORT}`);
  });

  it('renders only masked host when port is null and privacy mode is on', () => {
    expect(formatAddress('10.0.0.1', null, true)).toBe(MASKED_HOST);
  });
});

describe('formatConnLabel', () => {
  it('renders user@host:port when privacy mode is off', () => {
    expect(formatConnLabel('root', '10.0.0.1', 22, false)).toBe('root@10.0.0.1:22');
  });

  it('masks host and port but keeps username when privacy mode is on', () => {
    expect(formatConnLabel('root', '10.0.0.1', 22, true)).toBe(
      `root@${MASKED_HOST}:${MASKED_PORT}`,
    );
  });
});

describe('formatNameWithAddress', () => {
  it('renders "name (host:port)" when privacy mode is off', () => {
    expect(formatNameWithAddress('my server', '10.0.0.1', 22, false)).toBe(
      'my server (10.0.0.1:22)',
    );
  });

  it('masks host and port but keeps name when privacy mode is on', () => {
    expect(formatNameWithAddress('my server', '10.0.0.1', 22, true)).toBe(
      `my server (${MASKED_HOST}:${MASKED_PORT})`,
    );
  });
});
