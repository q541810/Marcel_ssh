import { useSessionStore } from '@/stores/sessionStore';
import { useAgentStore } from '@/stores/agentStore';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMode } from '@/lib/types';

export default function TerminalToolbar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const mode = useAgentStore((s) => s.mode);
  const setMode = useAgentStore((s) => s.setMode);

  const activeSession = activeSessionId ? sessions[activeSessionId] ?? null : null;

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-850 border-b border-zinc-800 bg-zinc-900/50">
      {/* Connection info */}
      <div className="flex items-center gap-2 text-sm">
        {activeSession ? (
          <>
            <span className="text-zinc-400">已连接到：</span>
            <span className="text-zinc-100 font-mono">
              {activeSession.connectionId}
            </span>
          </>
        ) : (
          <span className="text-zinc-500">无活动连接</span>
        )}
      </div>

      {/* Agent mode toggle */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-zinc-500 mr-2">模式：</span>
        {AGENT_MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value as AgentMode)}
            title={m.description}
            className={`
              px-2 py-0.5 rounded-lg text-xs font-medium transition-colors
              ${
                mode === m.value
                  ? 'bg-green-600 text-green-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
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
