/**
 * Bridge: sessionStore.activeSessionId → plugin events (`ssh://session-active`).
 *
 * Covers Tab click, connect auto-activate, and disconnect re-select without
 * patching every call site of setActiveSession.
 *
 * Dispatches through the existing per-plugin Tauri event fanout, which reaches
 * both the main window and plugin child WebViews.
 */

import { useSessionStore } from '@/stores/sessionStore';
import { dispatchPluginEvent } from './eventFanout';

export const SSH_SESSION_ACTIVE_EVENT = 'ssh://session-active';

export interface SessionActivePayload {
  sessionId: string | null;
  connectionId: string | null;
  previousSessionId: string | null;
  previousConnectionId: string | null;
}

let unsub: (() => void) | null = null;
let prevSessionId: string | null = null;
let prevConnectionId: string | null = null;

function connectionIdOf(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const s = useSessionStore.getState().sessions[sessionId];
  // configId = 持久化连接配置 ID；connectionId 字段在部分路径是展示用标签
  return s?.configId ?? s?.connectionId ?? null;
}

type DispatchFn = (event: string, data: unknown) => void;

/** Emit once if active session id changed. Exported for tests. */
export function emitSessionActiveIfChanged(
  nextSessionId: string | null,
  dispatch: DispatchFn = dispatchPluginEvent,
): SessionActivePayload | null {
  if (nextSessionId === prevSessionId) return null;

  const nextConnectionId = connectionIdOf(nextSessionId);

  const payload: SessionActivePayload = {
    sessionId: nextSessionId,
    connectionId: nextConnectionId,
    previousSessionId: prevSessionId,
    previousConnectionId: prevConnectionId,
  };

  prevSessionId = nextSessionId;
  prevConnectionId = nextConnectionId;

  dispatch(SSH_SESSION_ACTIVE_EVENT, payload);

  return payload;
}

/** Start watching sessionStore. Idempotent. */
export function initSessionActiveBridge(): void {
  if (unsub) return;

  prevSessionId = useSessionStore.getState().activeSessionId;
  prevConnectionId = connectionIdOf(prevSessionId);

  unsub = useSessionStore.subscribe((state) => {
    emitSessionActiveIfChanged(state.activeSessionId);
  });
}

/** Test / HMR helper. */
export function resetSessionActiveBridgeForTests(): void {
  unsub?.();
  unsub = null;
  prevSessionId = null;
  prevConnectionId = null;
}
