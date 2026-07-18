import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emitSessionActiveIfChanged,
  resetSessionActiveBridgeForTests,
  SSH_SESSION_ACTIVE_EVENT,
} from './sessionActiveBridge';

const sessionState = {
  sessions: {} as Record<string, { id: string; configId: string }>,
  activeSessionId: null as string | null,
};

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => sessionState,
    subscribe: vi.fn(),
  },
}));

vi.mock('./eventFanout', () => ({
  dispatchPluginEvent: vi.fn(),
}));

describe('sessionActiveBridge', () => {
  beforeEach(() => {
    resetSessionActiveBridgeForTests();
    sessionState.sessions = {
      s1: { id: 's1', configId: 'conn-a' },
      s2: { id: 's2', configId: 'conn-b' },
    };
    sessionState.activeSessionId = null;
  });

  it('default path dispatches once through plugin fanout', async () => {
    const { dispatchPluginEvent } = await import('./eventFanout');
    const payload = emitSessionActiveIfChanged('s1');

    expect(payload).toEqual({
      sessionId: 's1',
      connectionId: 'conn-a',
      previousSessionId: null,
      previousConnectionId: null,
    });
    expect(dispatchPluginEvent).toHaveBeenCalledWith(SSH_SESSION_ACTIVE_EVENT, payload);
  });

  it('uses an injected dispatch', () => {
    const dispatch = vi.fn();
    const payload = emitSessionActiveIfChanged('s1', dispatch);
    expect(dispatch).toHaveBeenCalledWith(SSH_SESSION_ACTIVE_EVENT, payload);
  });

  it('does not emit when session id is unchanged', () => {
    const dispatch = vi.fn();
    emitSessionActiveIfChanged('s1', dispatch);
    dispatch.mockClear();
    expect(emitSessionActiveIfChanged('s1', dispatch)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps previousConnectionId after session removed from map', () => {
    const dispatch = vi.fn();
    emitSessionActiveIfChanged('s1', dispatch);

    delete sessionState.sessions.s1;
    sessionState.activeSessionId = 's2';

    const payload = emitSessionActiveIfChanged('s2', dispatch);
    expect(payload).toMatchObject({
      sessionId: 's2',
      connectionId: 'conn-b',
      previousSessionId: 's1',
      previousConnectionId: 'conn-a',
    });
  });

  it('emits null when clearing active session', () => {
    const dispatch = vi.fn();
    emitSessionActiveIfChanged('s1', dispatch);
    const payload = emitSessionActiveIfChanged(null, dispatch);
    expect(payload).toMatchObject({
      sessionId: null,
      connectionId: null,
      previousSessionId: 's1',
      previousConnectionId: 'conn-a',
    });
  });
});
