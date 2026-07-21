import { RefreshCw, X } from 'lucide-react';
import type { Session } from '@/lib/types';
import { useConnectionStore } from '@/stores/connectionStore';
import {
  canReconnectSession,
  resolveSessionDisplayName,
  sessionStatusLabel,
} from './sessionUi';

interface MobileSessionHeaderProps {
  session: Session | null;
  onDisconnect: (sessionId: string) => void;
  onReconnect: (sessionId: string) => void;
}

export default function MobileSessionHeader({
  session,
  onDisconnect,
  onReconnect,
}: MobileSessionHeaderProps) {
  const connections = useConnectionStore((s) => s.connections);
  if (!session) return null;

  const displayName = resolveSessionDisplayName(session, connections);

  const statusColor =
    session.status === 'connected'
      ? 'text-emerald-400'
      : session.status === 'connecting'
        ? 'text-amber-400'
        : session.status === 'error'
          ? 'text-red-400'
          : 'text-zinc-400';

  return (
    <header
      className="relative flex flex-shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-medium text-zinc-100">
          {displayName}
        </div>
        <div className={`truncate text-[11px] ${statusColor}`}>
          {sessionStatusLabel(session.status)}
          <span className="text-zinc-600"> · {session.connectionId}</span>
          {session.errorMessage ? ` · ${session.errorMessage}` : ''}
        </div>
      </div>

      {canReconnectSession(session) && (
        <button
          type="button"
          onClick={() => onReconnect(session.id)}
          className="rounded-lg bg-zinc-800 p-2 text-zinc-300 transition-transform duration-100 active:scale-95 active:bg-zinc-700"
          aria-label="重连"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}

      <button
        type="button"
        onClick={() => onDisconnect(session.id)}
        className="rounded-lg bg-zinc-800 p-2 text-zinc-300 transition-transform duration-100 active:scale-95 active:bg-zinc-700"
        aria-label="断开"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}
