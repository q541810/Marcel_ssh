import type { AgentMessage as AgentMessageType } from '@/lib/types';
import Badge from '@/components/ui/Badge';
import { RISK_LEVEL_LABELS } from '@/lib/constants';

interface Props {
  message: AgentMessageType;
}

export default function AgentMessage({ message }: Props) {
  const roleStyles: Record<string, string> = {
    user: 'bg-indigo-900/30 border-indigo-800',
    assistant: 'bg-zinc-800 border-zinc-700',
    system: 'bg-amber-900/20 border-amber-800/50',
    tool: 'bg-emerald-900/20 border-emerald-800/50',
  };

  const roleLabels: Record<string, string> = {
    user: '您',
    assistant: '助手',
    system: '系统',
    tool: '工具',
  };

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  return (
    <div
      className={`rounded-lg border p-3 ${roleStyles[message.role] ?? 'bg-zinc-800 border-zinc-700'}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-400">
          {roleLabels[message.role] ?? message.role}
        </span>
        <span className="text-xs text-zinc-600">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>

      {/* Content */}
      <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words">
        {message.content}
      </div>

      {/* Tool call details */}
      {message.toolCall && (
        <div className="mt-2 p-2 rounded bg-zinc-900/50 border border-zinc-700/50">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-zinc-300">
              {message.toolCall.name}
            </span>
            <Badge
              variant={message.toolCall.riskLevel}
              size="sm"
            >
              {RISK_LEVEL_LABELS[message.toolCall.riskLevel]}
            </Badge>
            {message.toolCall.approved !== undefined && (
              <span
                className={`text-xs ${message.toolCall.approved ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {message.toolCall.approved ? '已批准' : '已拒绝'}
              </span>
            )}
          </div>
          {message.toolCall.result && (
            <pre className="text-xs text-zinc-400 mt-1 overflow-x-auto max-h-32 overflow-y-auto">
              {message.toolCall.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
