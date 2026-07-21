import { describe, it, expect } from 'vitest';
import {
  applyCtrlToggle,
  formatDisconnectBanner,
  needsPasteConfirmation,
  resolveAuxKeyInput,
  resolveDisconnectBannerKind,
  type TerminalInputState,
} from './terminalInput';

const initial: TerminalInputState = { ctrlActive: false };

describe('resolveAuxKeyInput', () => {
  it('emits Tab sequence without toggling ctrl', () => {
    const result = resolveAuxKeyInput(initial, 'tab');
    expect(result.write).toBe('\t');
    expect(result.next.ctrlActive).toBe(false);
  });

  it('toggles ctrl on without writing', () => {
    const result = resolveAuxKeyInput(initial, 'ctrl');
    expect(result.write).toBeNull();
    expect(result.next.ctrlActive).toBe(true);
  });

  it('toggles ctrl off when already active', () => {
    const result = resolveAuxKeyInput({ ctrlActive: true }, 'ctrl');
    expect(result.write).toBeNull();
    expect(result.next.ctrlActive).toBe(false);
  });

  it('emits Esc / arrows / slash', () => {
    expect(resolveAuxKeyInput(initial, 'esc').write).toBe('\x1b');
    expect(resolveAuxKeyInput(initial, 'up').write).toBe('\x1b[A');
    expect(resolveAuxKeyInput(initial, 'down').write).toBe('\x1b[B');
    expect(resolveAuxKeyInput(initial, 'left').write).toBe('\x1b[D');
    expect(resolveAuxKeyInput(initial, 'right').write).toBe('\x1b[C');
    expect(resolveAuxKeyInput(initial, 'slash').write).toBe('/');
  });

  it('emits Ctrl+C (ETX) and clears sticky ctrl', () => {
    const result = resolveAuxKeyInput({ ctrlActive: true }, 'ctrl-c');
    expect(result.write).toBe('\x03');
    expect(result.next.ctrlActive).toBe(false);
  });

  it('emits Ctrl+D (EOT) / Enter / pipe / dash for the second row', () => {
    expect(resolveAuxKeyInput(initial, 'ctrl-d').write).toBe('\x04');
    expect(resolveAuxKeyInput(initial, 'enter').write).toBe('\r');
    expect(resolveAuxKeyInput(initial, 'pipe').write).toBe('|');
    expect(resolveAuxKeyInput(initial, 'dash').write).toBe('-');
  });

  it('clears sticky ctrl after non-ctrl aux key', () => {
    const result = resolveAuxKeyInput({ ctrlActive: true }, 'tab');
    expect(result.write).toBe('\t');
    expect(result.next.ctrlActive).toBe(false);
  });

  it('copy is async host-handled: no write, clears sticky ctrl', () => {
    const result = resolveAuxKeyInput({ ctrlActive: true }, 'copy');
    expect(result.write).toBeNull();
    expect(result.next.ctrlActive).toBe(false);
  });
});

describe('needsPasteConfirmation', () => {
  it('single-line text pastes directly', () => {
    expect(needsPasteConfirmation('ls -la')).toBe(false);
    expect(needsPasteConfirmation('')).toBe(false);
  });

  it('requires confirmation for LF, CR and CRLF', () => {
    expect(needsPasteConfirmation('echo a\necho b')).toBe(true);
    expect(needsPasteConfirmation('echo a\r')).toBe(true);
    expect(needsPasteConfirmation('echo a\r\necho b')).toBe(true);
  });

  it('requires confirmation for trailing newline (would auto-execute)', () => {
    expect(needsPasteConfirmation('rm -rf /tmp/x\n')).toBe(true);
  });
});

describe('formatDisconnectBanner', () => {
  it('renders red title and gray detail for unexpected disconnect', () => {
    const banner = formatDisconnectBanner('disconnected', '网络超时');
    expect(banner).toContain('\x1b[31m--- 连接已断开 ---\x1b[0m');
    expect(banner).toContain('详细信息：网络超时');
  });

  it('uses manual title for user-initiated disconnect', () => {
    expect(formatDisconnectBanner('manual', '已主动断开连接')).toContain(
      '--- 已断开连接 ---',
    );
  });

  it('uses error title and default detail when reason empty', () => {
    const banner = formatDisconnectBanner('error', '   ');
    expect(banner).toContain('--- 连接失败 ---');
    expect(banner).toContain('详细信息：未知错误');
  });

  it('falls back to generic detail for non-error kinds', () => {
    expect(formatDisconnectBanner('disconnected', '')).toContain(
      '详细信息：连接已关闭',
    );
  });
});

describe('resolveDisconnectBannerKind', () => {
  it('error status always maps to error', () => {
    expect(resolveDisconnectBannerKind('error', '任何原因')).toBe('error');
  });

  it('manual disconnect reason maps to manual', () => {
    expect(resolveDisconnectBannerKind('disconnected', '已主动断开连接')).toBe(
      'manual',
    );
  });

  it('other disconnect reasons map to disconnected', () => {
    expect(resolveDisconnectBannerKind('disconnected', '连接已关闭')).toBe(
      'disconnected',
    );
    expect(resolveDisconnectBannerKind('disconnected', undefined)).toBe(
      'disconnected',
    );
  });
});

describe('applyCtrlToggle', () => {
  it('passes through when ctrl inactive', () => {
    const result = applyCtrlToggle(initial, 'c');
    expect(result.write).toBe('c');
    expect(result.next.ctrlActive).toBe(false);
  });

  it('maps next key to Ctrl+key and clears toggle', () => {
    const result = applyCtrlToggle({ ctrlActive: true }, 'c');
    expect(result.write).toBe('\x03');
    expect(result.next.ctrlActive).toBe(false);
  });

  it('maps Ctrl+A correctly', () => {
    expect(applyCtrlToggle({ ctrlActive: true }, 'a').write).toBe('\x01');
  });

  it('clears sticky ctrl on Enter without altering write', () => {
    const result = applyCtrlToggle({ ctrlActive: true }, '\r');
    expect(result.write).toBe('\r');
    expect(result.next.ctrlActive).toBe(false);
  });

  it('clears sticky ctrl on Backspace without altering write', () => {
    const result = applyCtrlToggle({ ctrlActive: true }, '\u007f');
    expect(result.write).toBe('\u007f');
    expect(result.next.ctrlActive).toBe(false);
  });
});
