import { describe, it, expect } from 'vitest';
import type { Session } from '@/lib/types';
import {
  shouldShowConnectionList,
  resolveTerminalPanelMode,
  panelVisibilityClass,
  canReconnectSession,
  sessionStatusLabel,
  listSessionsToDisconnectBeforeNewConnect,
} from './sessionUi';

function session(
  partial: Partial<Session> & Pick<Session, 'id' | 'status'>,
): Session {
  return {
    connectionId: 'user@host:22',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('shouldShowConnectionList', () => {
  it('shows list when there are no sessions', () => {
    expect(shouldShowConnectionList({}, null)).toBe(true);
  });

  it('shows list when active session is missing', () => {
    const sessions = {
      a: session({ id: 'a', status: 'connected' }),
    };
    expect(shouldShowConnectionList(sessions, null)).toBe(true);
  });

  it('hides list when active session is connected', () => {
    const sessions = {
      a: session({ id: 'a', status: 'connected' }),
    };
    expect(shouldShowConnectionList(sessions, 'a')).toBe(false);
  });

  it('hides list while connecting so status can show', () => {
    const sessions = {
      a: session({ id: 'a', status: 'connecting' }),
    };
    expect(shouldShowConnectionList(sessions, 'a')).toBe(false);
  });
});

describe('resolveTerminalPanelMode', () => {
  it('returns list when no active session', () => {
    expect(resolveTerminalPanelMode({}, null)).toBe('list');
  });

  it('returns terminal when active session is connected', () => {
    const sessions = {
      a: session({ id: 'a', status: 'connected' }),
    };
    expect(resolveTerminalPanelMode(sessions, 'a')).toBe('terminal');
  });

  it('returns connecting when active session is connecting', () => {
    const sessions = {
      a: session({ id: 'a', status: 'connecting' }),
    };
    expect(resolveTerminalPanelMode(sessions, 'a')).toBe('connecting');
  });

  it('returns error when active session is error', () => {
    const sessions = {
      a: session({ id: 'a', status: 'error', errorMessage: 'fail' }),
    };
    expect(resolveTerminalPanelMode(sessions, 'a')).toBe('error');
  });

  it('returns disconnected when active session is disconnected', () => {
    const sessions = {
      a: session({ id: 'a', status: 'disconnected' }),
    };
    expect(resolveTerminalPanelMode(sessions, 'a')).toBe('disconnected');
  });
});

describe('panelVisibilityClass', () => {
  it('keeps panel mounted and hidden when inactive', () => {
    expect(panelVisibilityClass(false)).toContain('hidden');
    expect(panelVisibilityClass(true)).not.toContain('hidden');
  });
});

describe('canReconnectSession', () => {
  it('allows reconnect when disconnected and configId present', () => {
    expect(
      canReconnectSession(
        session({ id: 'a', status: 'disconnected', configId: 'cfg-1' }),
      ),
    ).toBe(true);
  });

  it('disallows reconnect without configId', () => {
    expect(
      canReconnectSession(session({ id: 'a', status: 'disconnected' })),
    ).toBe(false);
  });

  it('allows reconnect on error with configId', () => {
    expect(
      canReconnectSession(
        session({ id: 'a', status: 'error', configId: 'cfg-1' }),
      ),
    ).toBe(true);
  });
});

describe('sessionStatusLabel', () => {
  it('returns Chinese labels', () => {
    expect(sessionStatusLabel('connecting')).toBe('连接中…');
    expect(sessionStatusLabel('connected')).toBe('已连接');
    expect(sessionStatusLabel('disconnected')).toBe('已断开');
    expect(sessionStatusLabel('error')).toBe('连接失败');
  });
});

describe('listSessionsToDisconnectBeforeNewConnect', () => {
  it('returns empty when no sessions', () => {
    expect(listSessionsToDisconnectBeforeNewConnect({})).toEqual([]);
  });

  it('returns every existing session id so mobile stays single-session', () => {
    const sessions = {
      a: session({ id: 'a', status: 'connected' }),
      b: session({ id: 'b', status: 'disconnected' }),
      c: session({ id: 'c', status: 'connecting' }),
      d: session({ id: 'd', status: 'error' }),
    };
    expect(listSessionsToDisconnectBeforeNewConnect(sessions).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('skips excludeId when reconnecting the same session shell', () => {
    const sessions = {
      keep: session({ id: 'keep', status: 'connected' }),
      drop: session({ id: 'drop', status: 'disconnected' }),
    };
    expect(listSessionsToDisconnectBeforeNewConnect(sessions, 'keep')).toEqual([
      'drop',
    ]);
  });
});
