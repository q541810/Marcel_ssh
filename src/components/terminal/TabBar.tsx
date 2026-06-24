import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';

export default function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disconnect = useSessionStore((s) => s.disconnect);
  const connections = useConnectionStore((s) => s.connections);
  const { onDisconnected } = useSessionLifecycle();

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

  return (
    <div className="flex items-center bg-zinc-900 border-b border-zinc-800 overflow-x-auto">
      <div className="flex items-center">
        {sessionList.map((session) => {
          const isActive = session.id === activeSessionId;
          const base = baseLabelOf(session);
          const label = labelCounts[base] > 1 ? `${base}:${dupIndex[session.id]}` : base;

          return (
            <div
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              className={`
                group flex items-center gap-2 px-3 py-2 text-xs cursor-pointer
                border-r border-zinc-800 min-w-0 max-w-[160px]
                transition-colors
                ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }
              `}
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

              {/* Close button */}
              <button
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
                  transition-opacity
                "
                title="关闭会话"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
