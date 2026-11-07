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
          : 'text-fg-secondary';

  return (
    <header
      className="relative flex flex-shrink-0 items-center gap-2 border-b border-edge-subtle bg-surface-sunken px-3 py-2"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-body font-medium text-fg">
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
        <div className={`truncate text-meta ${statusColor}`}>
          {sessionStatusLabel(session.status)}
          <span className="text-fg-disabled"> · {session.connectionId}</span>
          {session.errorMessage ? ` · ${session.errorMessage}` : ''}
        </div>
      </div>

      {session.status === 'connected' && (
        <button
          type="button"
          onClick={() => setForwardOpen(true)}
          className="hit-area flex h-8 w-8 items-center justify-center rounded-lg bg-surface-raised text-fg-secondary pressable active:bg-state-mid"
          aria-label="端口转发"
        >
          <ArrowLeftRight size={16} strokeWidth={1.5} />
        </button>
      )}

      {canReconnectSession(session) && (
        <button
          type="button"
          onClick={() => onReconnect(session.id)}
          className="hit-area flex h-8 w-8 items-center justify-center rounded-lg bg-surface-raised text-fg-secondary pressable active:bg-state-mid"
          aria-label="重连"
        >
          <RefreshCw size={16} strokeWidth={1.5} />
        </button>
      )}

      <button
        type="button"
        onClick={() => onDisconnect(session.id)}
        className="hit-area flex h-8 w-8 items-center justify-center rounded-lg bg-surface-raised text-fg-secondary pressable active:bg-state-mid"
        aria-label="断开"
      >
        <X size={16} strokeWidth={1.5} />
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
