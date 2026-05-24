import { useState } from 'react';
import type { AgentMessage } from '@/lib/types';

interface Props {
  messages: AgentMessage[];
}

const EXPLORATION_TOOLS = ['web_search', 'http_get', 'read_file'];

export function isExplorationTool(msg: AgentMessage): boolean {
  if (msg.role === 'tool' && msg.toolResult) {
    return EXPLORATION_TOOLS.includes(msg.toolResult.toolName);
  }
  return false;
}

function getCommandPreview(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  function asStr(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.value === 'string') return o.value;
      if (typeof o.text === 'string') return o.text;
    }
    return undefined;
  }
  if (toolName === 'read_file') {
    const path = asStr(args.path);
    if (path) return path;
  }
  if (toolName === 'web_search') {
    const query = asStr(args.query);
    if (query) return query;
  }
  if (toolName === 'http_get') {
    const url = asStr(args.url);
    if (url) return url;
  }
  return '';
}

export default function ExplorationGroup({ messages }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span>已探索 {messages.length} 次读取</span>
        </button>
        {expanded && (
          <div className="mt-1.5 space-y-1 pl-4 border-l-2 border-zinc-700">
            {messages.map((msg) => {
              const tr = msg.toolResult!;
              const preview = getCommandPreview(tr.toolName, tr.arguments);
              return (
                <div key={msg.id} className="text-xs text-zinc-400 leading-relaxed">
                  <span className="text-zinc-500">{tr.toolName}</span>
                  {preview && <span className="text-zinc-600 ml-1">—</span>}
                  {preview && <span className="text-zinc-500 ml-1">{preview}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
