import { describe, expect, it } from 'vitest';
import {
  isSyncedBrowserMode,
  resolveMobileSearchMode,
  selectMobileSearchMode,
} from './MobileAgentToolsSection';

describe('resolveMobileSearchMode', () => {
  it('treats browser（桌面同步而来，本机不可用）as html', () => {
    expect(resolveMobileSearchMode('browser')).toBe('html');
    expect(resolveMobileSearchMode('html')).toBe('html');
    expect(resolveMobileSearchMode(undefined)).toBe('html');
  });

  it('keeps api as api', () => {
    expect(resolveMobileSearchMode('api')).toBe('api');
  });
});

describe('isSyncedBrowserMode', () => {
  it('detects browser values synced from desktop', () => {
    expect(isSyncedBrowserMode('browser')).toBe(true);
    expect(isSyncedBrowserMode('html')).toBe(false);
    expect(isSyncedBrowserMode('api')).toBe(false);
    expect(isSyncedBrowserMode(undefined)).toBe(false);
  });
});

describe('selectMobileSearchMode', () => {
  it('selecting api always writes api', () => {
    expect(selectMobileSearchMode('browser', 'api')).toEqual({ webSearchMode: 'api' });
    expect(selectMobileSearchMode('html', 'api')).toEqual({ webSearchMode: 'api' });
    expect(selectMobileSearchMode('api', 'api')).toEqual({ webSearchMode: 'api' });
  });

  it('selecting html only rewrites when stored is api', () => {
    expect(selectMobileSearchMode('api', 'html')).toEqual({ webSearchMode: 'html' });
  });

  it('selecting html keeps synced browser value untouched (no cloud overwrite)', () => {
    expect(selectMobileSearchMode('browser', 'html')).toEqual({});
    expect(selectMobileSearchMode('html', 'html')).toEqual({});
    expect(selectMobileSearchMode(undefined, 'html')).toEqual({});
  });
});
