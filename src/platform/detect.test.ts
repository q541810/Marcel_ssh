import { describe, it, expect } from 'vitest';
import { collectPlatformHints, getAppPlatform, isMobilePlatform } from './detect';

describe('getAppPlatform', () => {
  it('returns mobile when detector reports android', () => {
    expect(getAppPlatform({ os: 'android' })).toBe('mobile');
  });

  it('returns mobile when detector reports ios', () => {
    expect(getAppPlatform({ os: 'ios' })).toBe('mobile');
  });

  it('returns desktop when detector reports windows', () => {
    expect(getAppPlatform({ os: 'windows' })).toBe('desktop');
  });

  it('returns desktop when detector reports macos', () => {
    expect(getAppPlatform({ os: 'macos' })).toBe('desktop');
  });

  it('returns desktop when detector reports linux', () => {
    expect(getAppPlatform({ os: 'linux' })).toBe('desktop');
  });

  it('returns mobile for mobile browser userAgent fallback', () => {
    expect(
      getAppPlatform({
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      }),
    ).toBe('mobile');
  });

  it('returns desktop for desktop browser userAgent fallback', () => {
    expect(
      getAppPlatform({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }),
    ).toBe('desktop');
  });

  it('isMobilePlatform mirrors getAppPlatform', () => {
    expect(isMobilePlatform({ os: 'android' })).toBe(true);
    expect(isMobilePlatform({ os: 'windows' })).toBe(false);
  });

  it('honors explicit force override', () => {
    expect(getAppPlatform({ force: 'mobile', os: 'windows' })).toBe('mobile');
    expect(getAppPlatform({ force: 'desktop', os: 'android' })).toBe('desktop');
  });
});

describe('collectPlatformHints', () => {
  it('maps ?platform=mobile to force mobile', () => {
    expect(collectPlatformHints({ search: '?platform=mobile' })).toEqual({
      force: 'mobile',
    });
  });

  it('maps ?platform=desktop to force desktop', () => {
    expect(collectPlatformHints({ search: '?platform=desktop' })).toEqual({
      force: 'desktop',
    });
  });

  it('honors VITE/env force and localStorage force (Tauri window has no query)', () => {
    expect(
      collectPlatformHints({
        envForce: 'mobile',
        tauriPlatform: 'windows',
        search: '',
        storageForce: null,
      }),
    ).toEqual({ force: 'mobile' });
    expect(
      collectPlatformHints({
        storageForce: 'mobile',
        tauriPlatform: 'windows',
        search: '',
        envForce: '',
      }),
    ).toEqual({ force: 'mobile' });
  });

  it('honors #platform=mobile hash force', () => {
    expect(collectPlatformHints({ hash: '#platform=mobile', search: '' })).toEqual({
      force: 'mobile',
    });
  });

  it('uses tauri platform as os when no force', () => {
    expect(
      collectPlatformHints({
        tauriPlatform: 'android',
        userAgent: 'desktop-ua',
        maxTouchPoints: 0,
        pointerCoarse: false,
        width: 1920,
        search: '',
        storageForce: null,
        envForce: '',
      }).os,
    ).toBe('android');
  });
});
