import { memo, useState, useEffect } from 'react';
import type { AgentMessage } from '@/lib/types';
import ToolCallCard from './ToolCallCard';

interface Props {
  messages: AgentMessage[];
  autoExpand?: boolean;
  /** 搜索命中组内消息时强制展开，便于定位 */
  forceExpand?: boolean;
  matchedIds?: Set<string>;
  flashId?: string | null;
}

const EXPLORATION_TOOLS = ['web_search', 'http_get', 'read_file', 'search_files', 'list_directory', 'system_info'];

export function isExplorationTool(msg: AgentMessage): boolean {
  if (msg.role === 'tool' && msg.toolResult) {
    return EXPLORATION_TOOLS.includes(msg.toolResult.toolName);
  }
  return false;
}

function ExplorationGroup({
  messages,
  autoExpand,
  forceExpand = false,
  matchedIds,
  flashId = null,
}: Props) {
  const [expanded, setExpanded] = useState(Boolean(autoExpand || forceExpand));

  useEffect(() => {
    if (forceExpand) {
      setExpanded(true);
      return;
    }
    if (!autoExpand) {
      setExpanded(false);
    }
  }, [autoExpand, forceExpand]);

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
          <span className="text-sm">
            <span className="text-zinc-300">已探索</span>
            <span className="text-zinc-500"> </span>
            <span
              key={messages.length}
              className="inline-block min-w-[1ch] text-right text-zinc-500 animate-exploration-count"
            >
              {messages.length}
            </span>
            <span className="text-zinc-500"> 次读取</span>
          </span>
        </button>
        {expanded && (
          <div className="mt-1.5 space-y-1">
            {messages.map((msg) => {
              const isMatch = matchedIds?.has(msg.id) ?? false;
              const isFlash = flashId === msg.id;
              return (
                <div
                  key={msg.id}
                  data-message-id={msg.id}
                  className={`relative rounded-lg transition-colors duration-500 ${
                    isFlash ? 'bg-indigo-500/20 ring-1 ring-indigo-400/30' : ''
                  } ${isMatch ? 'pl-2' : ''}`}
                >
                  {isMatch && (
                    <span
                      className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-indigo-400/70"
                      aria-hidden
                    />
                  )}
                  <ToolCallCard message={msg} autoExpand={autoExpand || forceExpand} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ExplorationGroup);
