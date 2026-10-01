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

  it('keeps the passwordless debug session available to the assistant', () => {
    const debug = session({
      id: 'debug-session:test',
      status: 'connected',
      connectionId: 'msfakeserver',
      configId: 'debug:msfakeserver',
    });
    expect(agentEmptyStateReason(debug)).toBe('ready');
    expect(resolveAgentIds(debug)).toEqual({
      sessionId: 'debug-session:test',
      configId: 'debug:msfakeserver',
    });
    expect(canSendAgentPrompt(debug, false, 'hello')).toBe(true);
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

  it('blocks send while the conversation is being compacted', () => {
    // busy 的第二种来源：手动压缩上下文。调用方算的是
    // `isRunning || isCompacting`（或 conversationIsBusy）—— 压缩不是任务，
    // 只看 isRunning 时它完全隐形，而这期间发出去的消息会被随后落下的压缩卡
    // 盖到后面、被归档边界从后续请求里抹掉。
    const running = false;
    const compacting = true;
    expect(
      canSendAgentPrompt(
        session({ id: 's1', status: 'connected', configId: 'cfg-1' }),
        running || compacting,
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
