import { useSessionStore } from '@/stores/sessionStore';

export default function TerminalTabs() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disconnect = useSessionStore((s) => s.disconnect);

  const sessionList = Object.values(sessions);

  const handleClose = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    disconnect(sessionId);
  };

  return (
    <div className="flex items-center gap-0.5 bg-zinc-950 px-2 py-1 overflow-x-auto border-b border-zinc-800">
      {sessionList.map((session) => (
        <button
          key={session.id}
          onClick={() => setActiveSession(session.id)}
          className={`
            flex items-center gap-2 px-3 py-1.5 rounded-t-lg text-sm whitespace-nowrap
            transition-colors duration-150
            ${
              activeSessionId === session.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }
          `}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              session.status === 'connected'
                ? 'bg-emerald-500'
                : session.status === 'connecting'
                  ? 'bg-amber-500 animate-pulse'
                  : session.status === 'error'
                    ? 'bg-red-500'
                    : 'bg-zinc-600'
            }`}
          />
          <span className="max-w-32 truncate">{session.connectionId}</span>
          <button
            onClick={(e) => handleClose(e, session.id)}
            className="ml-1 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 rounded-lg px-1"
            aria-label="关闭会话"
          >
            &times;
          </button>
        </button>
      ))}
      <button
        className="px-2 py-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 rounded-lg text-lg leading-none"
        aria-label="新建连接"
      >
        +
      </button>
    </div>
  );
}
