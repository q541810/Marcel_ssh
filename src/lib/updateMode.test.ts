import { describe, expect, it } from 'vitest';
import {
  availableUpdateModes,
  displayUpdateMode,
  normalizeUpdateMode,
  updateModeDescription,
  UPDATE_MODES,
} from './updateMode';

describe('normalizeUpdateMode', () => {
  it('passes through the three valid values', () => {
    expect(normalizeUpdateMode({ updateMode: 'auto' })).toBe('auto');
    expect(normalizeUpdateMode({ updateMode: 'notify' })).toBe('notify');
    expect(normalizeUpdateMode({ updateMode: 'off' })).toBe('off');
  });

  it('derives from the legacy autoUpdate flag when updateMode is absent', () => {
    // 旧语义：autoUpdate=false 就是「仍然检查、只提示」= 仅提醒。
    expect(normalizeUpdateMode({ autoUpdate: false })).toBe('notify');
    expect(normalizeUpdateMode({ updateMode: undefined, autoUpdate: false })).toBe('notify');
    expect(normalizeUpdateMode({ updateMode: undefined, autoUpdate: true })).toBe('auto');
  });

  it('defaults to auto when neither field is present (old backend / empty config)', () => {
    expect(normalizeUpdateMode({})).toBe('auto');
    expect(normalizeUpdateMode(null)).toBe('auto');
    expect(normalizeUpdateMode(undefined)).toBe('auto');
  });

  it('degrades unknown values (future modes / empty string) to notify, never to auto', () => {
    // 未来版本写入第四种模式、或字段被写成空串时，不能当「自动更新」处理：
    // 那会在用户不知情时自动下载几十 MB。与后端 Rust 侧同一个保守取值。
    expect(normalizeUpdateMode({ updateMode: 'quiet', autoUpdate: true })).toBe('notify');
    expect(normalizeUpdateMode({ updateMode: '' })).toBe('notify');
  });

  it('treats an explicit null as absent (derives from the legacy flag)', () => {
    expect(normalizeUpdateMode({ updateMode: null, autoUpdate: false })).toBe('notify');
    expect(normalizeUpdateMode({ updateMode: null, autoUpdate: true })).toBe('auto');
  });
});

describe('availableUpdateModes / displayUpdateMode', () => {
  it('offers all three modes only when the platform can install silently', () => {
    expect(availableUpdateModes(true)).toEqual([...UPDATE_MODES]);
    expect(availableUpdateModes(false)).toEqual(['notify', 'off']);
  });

  it('shows a stored auto as notify on platforms without silent download', () => {
    // 后端在这些平台本来就不会自动下载，展示成等价的「仅提醒」而不是
    // 一个点了必然失败的「自动更新」。
    expect(displayUpdateMode('auto', false)).toBe('notify');
    expect(displayUpdateMode('auto', true)).toBe('auto');
    expect(displayUpdateMode('off', false)).toBe('off');
  });
});

describe('updateModeDescription', () => {
  it('explains each mode without empty text', () => {
    for (const mode of UPDATE_MODES) {
      expect(updateModeDescription(mode, false).length).toBeGreaterThan(0);
      expect(updateModeDescription(mode, true).length).toBeGreaterThan(0);
    }
  });

  it('tells android users that auto download waits for Wi-Fi', () => {
    expect(updateModeDescription('auto', true)).toContain('Wi-Fi');
  });

  it('states that off mode never checks for new versions', () => {
    expect(updateModeDescription('off', false)).toContain('不检查新版本');
  });
});
