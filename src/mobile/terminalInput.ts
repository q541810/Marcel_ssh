export type AuxKeyId =
  | 'tab'
  | 'ctrl'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'esc'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'slash'
  | 'pipe'
  | 'dash'
  | 'enter'
  | 'paste'
  | 'copy';

export interface TerminalInputState {
  ctrlActive: boolean;
}

export interface AuxKeyResult {
  write: string | null;
  next: TerminalInputState;
}

const AUX_SEQUENCES: Record<
  Exclude<AuxKeyId, 'ctrl' | 'ctrl-c' | 'ctrl-d' | 'paste' | 'copy'>,
  string
> = {
  tab: '\t',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  slash: '/',
  pipe: '|',
  dash: '-',
  enter: '\r',
};

export function resolveAuxKeyInput(
  state: TerminalInputState,
  key: AuxKeyId,
): AuxKeyResult {
  if (key === 'ctrl') {
    return { write: null, next: { ctrlActive: !state.ctrlActive } };
  }
  if (key === 'ctrl-c') {
    return { write: '\x03', next: { ctrlActive: false } };
  }
  if (key === 'ctrl-d') {
    return { write: '\x04', next: { ctrlActive: false } };
  }
  if (key === 'paste' || key === 'copy') {
    // Clipboard keys are async (clipboard IPC) — handled by the host, no direct write.
    return { write: null, next: { ctrlActive: false } };
  }
  return {
    write: AUX_SEQUENCES[key],
    next: { ctrlActive: false },
  };
}

/**
 * Multi-line paste guard — same semantics as the desktop right-click paste
 * (TerminalInstanceManager): any CR/LF in the text may execute commands on
 * paste, so it must be confirmed by the user first.
 */
export function needsPasteConfirmation(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}

export type DisconnectBannerKind = 'disconnected' | 'error' | 'manual';

/**
 * Same wording/colors as desktop TerminalInstanceManager.showDisconnectBanner,
 * with a mobile-appropriate reconnect hint. Written into the xterm buffer so
 * the break point stays visible in scrollback history.
 */
export function formatDisconnectBanner(
  kind: DisconnectBannerKind,
  detail: string,
): string {
  const title =
    kind === 'error'
      ? '--- 连接失败 ---'
      : kind === 'manual'
        ? '--- 已断开连接 ---'
        : '--- 连接已断开 ---';
  const safeDetail =
    detail.trim() || (kind === 'error' ? '未知错误' : '连接已关闭');
  return (
    `\r\n\x1b[31m${title}\x1b[0m\r\n` +
    `\x1b[90m详细信息：${safeDetail}\x1b[0m\r\n` +
    `\x1b[90m若您想要尝试重新连接，请点击顶部的重连按钮\x1b[0m\r\n`
  );
}

/**
 * Desktop-parity kind mapping (sessionStore.updateSessionStatus): an explicit
 * user disconnect reason renders as "manual", everything else "disconnected".
 */
export function resolveDisconnectBannerKind(
  status: 'disconnected' | 'error',
  reason: string | undefined,
): DisconnectBannerKind {
  if (status === 'error') return 'error';
  return reason?.trim() === '已主动断开连接' ? 'manual' : 'disconnected';
}

export function applyCtrlToggle(
  state: TerminalInputState,
  char: string,
): { write: string; next: TerminalInputState } {
  if (!state.ctrlActive || char.length !== 1) {
    return { write: char, next: state };
  }
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    return {
      write: String.fromCharCode(code - 64),
      next: { ctrlActive: false },
    };
  }
  return { write: char, next: { ctrlActive: false } };
}

/**
 * Mobile input batching.
 *
 * On Android every `invoke('ssh_send_input')` is a full WebView→Java→Rust
 * roundtrip; sending one per keystroke saturates the main thread under fast
 * typing and makes the WebView drop IME commits (swallowed characters).
 * `createInputBatcher` accumulates printable text and flushes it in one IPC
 * call per tick, while control characters (ESC sequences, Ctrl+C/D, Enter,
 * Backspace…) flush immediately so interactive keys never wait for a tick.
 * Order is preserved: a pending buffer is always flushed before an immediate
 * payload.
 */

/** Any C0 control char (0x00–0x1F) or DEL (0x7F) must go out immediately. */
export function containsControlChar(payload: string): boolean {
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface InputBatcherOptions {
  /** Called with the accumulated payload (once per flush). */
  flush: (payload: string) => void;
  /** Periodic flush interval in ms. Defaults to one frame (16). */
  flushIntervalMs?: number;
  /** Buffer length (UTF-16 units) above which a flush happens immediately. Defaults to 64. */
  maxBufferLength?: number;
  /** Whether `data` must be sent immediately instead of buffered. Defaults to `containsControlChar`. */
  isImmediate?: (payload: string) => boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface InputBatcher {
  /** Append input; flushes immediately for control payloads / buffer overflow. */
  push(data: string): void;
  /** Send whatever is buffered right now. No-op when empty. */
  flush(): void;
  /** Cancel the pending timer and drop the buffered remainder. */
  dispose(): void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_BUFFER_LENGTH = 64;

export function createInputBatcher(
  options: InputBatcherOptions,
): InputBatcher {
  const flushIntervalMs =
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferLength =
    options.maxBufferLength ?? DEFAULT_MAX_BUFFER_LENGTH;
  const isImmediate = options.isImmediate ?? containsControlChar;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;

  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const payload = buffer;
    buffer = '';
    options.flush(payload);
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setT(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
  }

  return {
    push(data) {
      if (data.length === 0) return;
      if (isImmediate(data)) {
        // Send buffered text first so the byte order matches key order.
        flush();
        options.flush(data);
        return;
      }
      buffer += data;
      if (buffer.length >= maxBufferLength) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      buffer = '';
    },
  };
}
