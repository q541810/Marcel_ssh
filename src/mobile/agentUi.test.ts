import { describe, it, expect } from 'vitest';
import type { Session } from '@/lib/types';
import {
  canSendAgentPrompt,
  agentEmptyStateReason,
  resolveAgentIds,
} from './agentUi';

function session(
  partial: Partial<Session> & Pick<Session, 'id' | 'status'>,
): Session {
  return {
    connectionId: 'user@host:22',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('canSendAgentPrompt', () => {
  it('allows send when connected with configId, not running, and draft non-empty', () => {
    expect(
      canSendAgentPrompt(
        session({ id: 's1', status: 'connected', configId: 'cfg-1' }),
        false,
        'hello',
      ),
    ).toBe(true);
  });

  it('blocks send when connected without configId', () => {
    expect(
      canSendAgentPrompt(
        session({ id: 's1', status: 'connected' }),
        false,
        'hello',
      ),
    ).toBe(false);
  });

  it('blocks send when draft is empty or whitespace', () => {
    const s = session({ id: 's1', status: 'connected', configId: 'cfg-1' });
    expect(canSendAgentPrompt(s, false, '')).toBe(false);
    expect(canSendAgentPrompt(s, false, '   ')).toBe(false);
  });

  it('blocks send when not connected or null session', () => {
    expect(canSendAgentPrompt(null, false, 'hi')).toBe(false);
    expect(
      canSendAgentPrompt(
        session({ id: 's1', status: 'disconnected', configId: 'cfg-1' }),
        false,
        'hi',
      ),
    ).toBe(false);
    expect(
      canSendAgentPrompt(
        session({ id: 's1', status: 'connecting', configId: 'cfg-1' }),
        false,
        'hi',
      ),
    ).toBe(false);
  });

  it('blocks send while task is running', () => {
    expect(
      canSendAgentPrompt(
        session({ id: 's1', status: 'connected', configId: 'cfg-1' }),
        true,
        'hi',
      ),
    ).toBe(false);
  });
});

describe('agentEmptyStateReason', () => {
  it('returns no-session when session is null', () => {
    expect(agentEmptyStateReason(null)).toBe('no-session');
  });

  it('maps session status to empty-state reasons', () => {
    expect(
      agentEmptyStateReason(session({ id: 's1', status: 'connecting' })),
    ).toBe('connecting');
    expect(
      agentEmptyStateReason(session({ id: 's1', status: 'disconnected' })),
    ).toBe('disconnected');
    expect(agentEmptyStateReason(session({ id: 's1', status: 'error' }))).toBe(
      'error',
    );
    expect(
      agentEmptyStateReason(
        session({ id: 's1', status: 'connected', configId: 'cfg-1' }),
      ),
    ).toBe('ready');
    expect(
      agentEmptyStateReason(session({ id: 's1', status: 'connected' })),
    ).toBe('no-config');
  });
});

describe('resolveAgentIds', () => {
  it('returns sessionId and configId from session.configId only', () => {
    expect(
      resolveAgentIds(
        session({
          id: 'sess-1',
          status: 'connected',
          configId: 'cfg-99',
          connectionId: 'user@host:22',
        }),
      ),
    ).toEqual({ sessionId: 'sess-1', configId: 'cfg-99' });
  });

  it('returns null when session missing or configId missing', () => {
    expect(resolveAgentIds(null)).toBeNull();
    expect(
      resolveAgentIds(
        session({
          id: 'sess-1',
          status: 'connected',
          connectionId: 'user@host:22',
        }),
      ),
    ).toBeNull();
  });

  it('does not treat connectionId as configId', () => {
    expect(
      resolveAgentIds(
        session({
          id: 'sess-1',
          status: 'connected',
          connectionId: 'user@host:22',
        }),
      ),
    ).toBeNull();
  });
});
