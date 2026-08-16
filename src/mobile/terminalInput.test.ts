import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  applyCtrlToggle,
  containsControlChar,
  createInputBatcher,
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

describe('containsControlChar', () => {
  it('detects C0 control chars and DEL', () => {
    expect(containsControlChar('\x1b')).toBe(true);
    expect(containsControlChar('\x03')).toBe(true);
    expect(containsControlChar('\x1b[A')).toBe(true);
    expect(containsControlChar('\r')).toBe(true);
    expect(containsControlChar('\u007f')).toBe(true);
  });

  it('passes through printable text including CJK', () => {
    expect(containsControlChar('ls -la')).toBe(false);
    expect(containsControlChar('中文输入')).toBe(false);
    expect(containsControlChar('')).toBe(false);
  });
});

describe('createInputBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const collect = () => {
    const sent: string[] = [];
    const batcher = createInputBatcher({ flush: (p) => sent.push(p) });
    return { batcher, sent };
  };

  it('accumulates printable text and flushes once per tick', () => {
    vi.useFakeTimers();
    const { batcher, sent } = collect();
    batcher.push('a');
    batcher.push('b');
    batcher.push('cd');
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(sent).toEqual(['abcd']);
  });

  it('coalesces a burst of keys into a single flush', () => {
    vi.useFakeTimers();
    const { batcher, sent } = collect();
    batcher.push('a');
    vi.advanceTimersByTime(8);
    batcher.push('b');
    vi.advanceTimersByTime(4);
    expect(sent).toEqual([]);
    batcher.push('c');
    vi.advanceTimersByTime(4); // t=16: the one pending timer fires for the whole burst
    expect(sent).toEqual(['abc']);
  });

  it('flushes buffered text before an immediate control payload, keeping order', () => {
    vi.useFakeTimers();
    const { batcher, sent } = collect();
    batcher.push('ab');
    batcher.push('\x1b[A'); // arrow sequence must not wait for the tick
    expect(sent).toEqual(['ab', '\x1b[A']);
  });

  it('flushes immediately on buffer overflow', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createInputBatcher({
      flush: (p) => sent.push(p),
      maxBufferLength: 4,
    });
    batcher.push('abc');
    expect(sent).toEqual([]);
    batcher.push('d');
    expect(sent).toEqual(['abcd']);
  });

  it('manual flush sends the remainder once', () => {
    vi.useFakeTimers();
    const { batcher, sent } = collect();
    batcher.push('ab');
    batcher.flush();
    batcher.flush(); // empty — no-op
    expect(sent).toEqual(['ab']);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['ab']);
  });

  it('dispose drops the buffered remainder and cancels the timer', () => {
    vi.useFakeTimers();
    const { batcher, sent } = collect();
    batcher.push('ab');
    batcher.dispose();
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
  });

  it('ignores empty pushes', () => {
    vi.useFakeTimers();
    const { batcher, sent } = collect();
    batcher.push('');
    batcher.push('x');
    vi.advanceTimersByTime(16);
    expect(sent).toEqual(['x']);
  });

  it('custom isImmediate predicate controls the fast path', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const batcher = createInputBatcher({
      flush: (p) => sent.push(p),
      isImmediate: (p) => p === '!',
    });
    batcher.push('a');
    batcher.push('!');
    expect(sent).toEqual(['a', '!']);
    batcher.push('\x1b[A'); // not "immediate" under the custom predicate
    vi.advanceTimersByTime(16);
    expect(sent).toEqual(['a', '!', '\x1b[A']);
  });
});
