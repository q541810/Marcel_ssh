import { useState } from 'react';
import { ArrowLeftRight, RefreshCw, X } from 'lucide-react';
import PortForwardView from '@/components/terminal/PortForwardView';
import MobileSheet from './ui/MobileSheet';
import type { Session } from '@/lib/types';
import { useConnectionStore } from '@/stores/connectionStore';
import { useTaskStore } from '@/stores/taskStore';
import { getSessionAgentStatus } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
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
  const [forwardOpen, setForwardOpen] = useState(false);
  const connections = useConnectionStore((s) => s.connections);
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
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
      className="relative flex flex-shrink-0 items-center gap-2 border-b border-edge-subtle bg-zinc-950 px-3 py-2"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm font-medium text-zinc-100">
            {displayName}
          </span>
          <AgentStatusIndicator
            status={getSessionAgentStatus(
              session.id,
              tasks,
              unreadCompletedConversations,
            )}
            size="xs"
          />
        </div>
        <div className={`truncate text-[11px] ${statusColor}`}>
          {sessionStatusLabel(session.status)}
          <span className="text-zinc-600"> · {session.connectionId}</span>
          {session.errorMessage ? ` · ${session.errorMessage}` : ''}
        </div>
      </div>

      {session.status === 'connected' && (
        <button
          type="button"
          onClick={() => setForwardOpen(true)}
          className="rounded-lg bg-zinc-800 p-2 text-zinc-300 transition-transform duration-100 active:scale-95 active:bg-state-mid"
          aria-label="端口转发"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
      )}

      {canReconnectSession(session) && (
        <button
          type="button"
          onClick={() => onReconnect(session.id)}
          className="rounded-lg bg-zinc-800 p-2 text-zinc-300 transition-transform duration-100 active:scale-95 active:bg-state-mid"
          aria-label="重连"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}

      <button
        type="button"
        onClick={() => onDisconnect(session.id)}
        className="rounded-lg bg-zinc-800 p-2 text-zinc-300 transition-transform duration-100 active:scale-95 active:bg-state-mid"
        aria-label="断开"
      >
        <X className="h-4 w-4" />
      </button>
      <MobileSheet
        open={forwardOpen}
        onClose={() => setForwardOpen(false)}
        title="端口转发"
        maxHeightClassName="max-h-[min(80dvh,calc(100dvh-var(--ime-bottom,0px)))]"
      >
        <div className="h-[60dvh]">
          <PortForwardView sessionId={session.id} touch />
        </div>
      </MobileSheet>
    </header>
  );
}
