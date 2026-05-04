import type { AgentMessage as AgentMessageType } from '@/lib/types';
import Badge from '@/components/ui/Badge';
import { RISK_LEVEL_LABELS } from '@/lib/constants';
import Markdown from 'react-markdown';

interface Props {
  message: AgentMessageType;
}

const ROLE_STYLES: Record<string, string> = {
  user: 'bg-indigo-900/30 border-indigo-800',
  assistant: 'bg-zinc-800 border-zinc-700',
  system: 'bg-amber-900/20 border-amber-800/50',
  tool: 'bg-emerald-900/20 border-emerald-800/50',
};

const ROLE_LABELS: Record<string, string> = {
  user: '您',
  assistant: '助手',
  system: '系统',
  tool: '工具',
};

const MARKDOWN_CLASS = 'text-sm text-zinc-200 whitespace-pre-wrap break-words prose prose-invert prose-sm max-w-none prose-p:my-1 prose-code:text-pink-300 prose-code:bg-zinc-900 prose-code:px-1 prose-code:py-0.5 prose-code:rounded-lg prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-a:text-indigo-400 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-400 prose-blockquote:italic';

export default function AgentMessage({ message }: Props) {
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

  // Hide empty, non-loading assistant messages (e.g. placeholder left over from tool calls)
  if (!message.isLoading && message.content === '' && message.role === 'assistant') {
    return null;
  }

  // Hide assistant messages that are purely tool-call placeholders (no user-visible text).
  // These are identified by having a toolCall but empty or placeholder content — the actual
  // tool output is rendered by ToolCallCard via the 'tool' role message.
  if (message.role === 'assistant' && message.toolCall && !message.content) {
    return null;
  }

  return (
    <div
      className={`rounded-xl border p-3 ${ROLE_STYLES[message.role] ?? 'bg-zinc-800 border-zinc-700'}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-400">
          {ROLE_LABELS[message.role] ?? message.role}
        </span>
        <span className="text-xs text-zinc-600">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>

      {/* Content */}
      {message.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>思考中...</span>
        </div>
      ) : !message.content ? (
        <div className="text-sm text-zinc-500 italic">（无内容）</div>
      ) : (
        <div className={MARKDOWN_CLASS}>
          {message.role === 'user' ? (
            message.content
          ) : (
            <Markdown>{message.content}</Markdown>
          )}
        </div>
      )}

      {/* Tool call details */}
      {message.toolCall && (
        <div className="mt-2 p-2 rounded-lg bg-zinc-900/50 border border-zinc-700/50">
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
