import type { MouseEvent } from 'react';
import WinIcon from '@/components/ui/WinIcon';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { useHostKeyMismatch } from '@/hooks/useHostKeyMismatch';
import { asHostKeyMismatch, parseAppError } from '@/lib/errors';

export default function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disconnect = useSessionStore((s) => s.disconnect);
  const reconnect = useSessionStore((s) => s.reconnect);
  const connections = useConnectionStore((s) => s.connections);
  const { onDisconnected } = useSessionLifecycle();
  const mismatch = useHostKeyMismatch();

  const sessionList = Object.values(sessions);

  if (sessionList.length === 0) {
    return null;
  }

  const baseLabelOf = (session: (typeof sessionList)[number]) => {
    const saved = session.configId ? connections.find((c) => c.id === session.configId) : null;
    return saved?.name || session.connectionId || '未命名';
  };

  const labelCounts: Record<string, number> = {};
  for (const s of sessionList) {
    const l = baseLabelOf(s);
    labelCounts[l] = (labelCounts[l] || 0) + 1;
  }

  const dupSeen: Record<string, number> = {};
  const dupIndex: Record<string, number> = {};
  sessionList
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((s) => {
      const l = baseLabelOf(s);
      if (labelCounts[l] > 1) {
        const idx = dupSeen[l] || 0;
        dupSeen[l] = idx + 1;
        dupIndex[s.id] = idx;
      }
    });

  const handleReconnect = (sessionId: string, e: MouseEvent) => {
    e.stopPropagation();
    reconnect(sessionId).catch((err) => {
      const m = asHostKeyMismatch(parseAppError(err));
      if (m) {
        mismatch.prompt({
          data: m,
          onTrust: () =>
            reconnect(sessionId, true).catch((reErr) => {
              console.error('重连失败:', reErr);
            }),
        });
        return;
      }
      console.error('重连失败:', err);
    });
  };

  return (
    <>
      <div className="flex items-center win-acrylic border-b border-zinc-800 overflow-x-auto">
        <div className="flex items-center">
          {sessionList.map((session) => {
            const isActive = session.id === activeSessionId;
            const base = baseLabelOf(session);
            const label = labelCounts[base] > 1 ? `${base}:${dupIndex[session.id]}` : base;
            const canReconnect =
              (session.status === 'disconnected' || session.status === 'error') &&
              Boolean(session.configId);
            const showReconnectHint =
              session.status === 'disconnected' || session.status === 'error';

            return (
              <div
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className={`win-tab group ${isActive ? 'active' : ''} min-w-0 cursor-pointer`}
              >
                {/* Status dot */}
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    session.status === 'connected'
                      ? 'bg-emerald-500'
                      : session.status === 'connecting'
                        ? 'bg-amber-500 animate-pulse'
                        : session.status === 'error'
                          ? 'bg-red-500'
                          : 'bg-zinc-600'
                  }`}
                />

                {/* Label */}
                <span className="truncate flex-1">{label}</span>

                {/* Reconnect on disconnected/error */}
                {showReconnectHint && (
                  <button
                    type="button"
                    onClick={(e) => {
                      if (!canReconnect) {
                        e.stopPropagation();
                        return;
                      }
                      handleReconnect(session.id, e);
                    }}
                    disabled={!canReconnect || session.status === 'connecting'}
                    className={`
                      p-0.5 rounded flex-shrink-0 transition-colors
                      ${
                        canReconnect
                          ? 'text-zinc-400 hover:bg-zinc-700 hover:text-emerald-500'
                          : 'text-zinc-600 cursor-not-allowed'
                      }
                    `}
                    title={
                      canReconnect
                        ? '重新连接'
                        : '临时连接无法自动重连，请去侧边栏重新连接'
                    }
                  >
                    <WinIcon glyph="refresh" size={12} />
                  </button>
                )}

                {/* Close button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const configId = session.configId;
                    disconnect(session.id).then(() => {
                      if (configId) {
                        onDisconnected(configId);
                      }
                    });
                  }}
                  className="
                    opacity-0 group-hover:opacity-100
                    p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200
                    transition-opacity flex-shrink-0
                  "
                  title="关闭会话"
                >
                  <WinIcon glyph="close" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {mismatch.Modal}
    </>
  );
}
