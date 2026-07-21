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
