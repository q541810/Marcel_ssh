import { useSessionStore } from '@/stores/sessionStore';
import { useTaskStore } from '@/stores/taskStore';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMode } from '@/lib/types';

export default function TerminalToolbar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const mode = useTaskStore((s) => s.mode);
  const setMode = useTaskStore((s) => s.setMode);

  const activeSession = activeSessionId ? sessions[activeSessionId] ?? null : null;

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-850 border-b border-edge-subtle bg-surface/50">
      {/* Connection info */}
      <div className="flex items-center gap-2 text-read">
        {activeSession ? (
          <>
            <span className="text-fg-secondary">已连接到：</span>
            <span className="text-fg font-mono">
              {activeSession.connectionId}
            </span>
          </>
        ) : (
          <span className="text-fg-tertiary">无活动连接</span>
        )}
      </div>

      {/* Agent mode toggle */}
      <div className="flex items-center gap-1">
        <span className="text-meta text-fg-tertiary mr-2">模式：</span>
        {AGENT_MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value as AgentMode)}
            title={m.description}
            className={`
              px-2 py-0.5 rounded-lg text-meta font-medium transition-colors
              ${
                mode === m.value
                  ? 'bg-indigo-600 text-indigo-100'
                  : 'text-fg-secondary hover:text-fg hover:bg-state-mid'
              }
            `}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
