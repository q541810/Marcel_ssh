import { useState } from 'react';
import type { AgentMessage } from '@/lib/types';

interface Props {
  message: AgentMessage;
}

const TOOL_ICONS: Record<string, JSX.Element> = {
  execute_command: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  read_file: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  write_file: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  ),
  list_directory: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  search_files: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
  system_info: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
};

const DEFAULT_ICON = (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export default function ToolCallCard({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tr = message.toolResult;
  if (!tr) return null;

  const icon = TOOL_ICONS[tr.toolName] ?? DEFAULT_ICON;

  return (
    <button
      onClick={() => setExpanded((v) => !v)}
      className={`
        group w-full text-left rounded-lg border transition-colors
        ${
          tr.blocked
            ? 'border-red-800/60 bg-red-950/30'
            : tr.success
              ? 'border-zinc-700/60 bg-zinc-800/50'
              : 'border-amber-800/60 bg-amber-950/20'
        }
      `}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Tool name badge */}
          <span
            className={`
              flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg
              ${
                tr.blocked
                  ? 'bg-red-900/50 text-red-300'
                  : 'bg-zinc-700/80 text-zinc-300'
              }
            `}
          >
            {icon}
            <span>{tr.toolName}</span>
          </span>

          {/* Summary on the right */}
          <span className="text-sm text-zinc-400 truncate">
            {tr.summary}
          </span>

          {tr.blocked && (
            <span className="flex-shrink-0 text-xs text-red-400 font-medium">
              已阻止
            </span>
          )}
        </div>

        {/* Expand arrow — visible on hover */}
        <svg
          className={`
            w-4 h-4 flex-shrink-0 text-zinc-500
            transition-all duration-200
            opacity-0 group-hover:opacity-100
            ${expanded ? 'rotate-180' : ''}
          `}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </div>

      {/* Expandable result area */}
      {expanded && (
        <div className="border-t border-zinc-700/50 px-3 py-2">
          <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono leading-relaxed">
            {tr.result || '(无输出)'}
          </pre>
        </div>
      )}
    </button>
  );
}
