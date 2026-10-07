import { memo, useState, useEffect } from 'react';
import type { AgentMessage } from '@/lib/types';
import ToolCallCard from './ToolCallCard';
import { isExplorationTool as isExplorationToolName, isPlanTool } from '@/lib/toolCatalog';
import ToolCallSummary from './ToolCallSummary';

export type ToolGroupKind = 'tools' | 'exploration' | 'plan';

/** Legacy classification helper; grouping now includes every completed tool. */
export function isExplorationTool(msg: AgentMessage): boolean {
  if (msg.role === 'tool' && msg.toolResult) {
    return isExplorationToolName(msg.toolResult.toolName);
  }
  return false;
}

/** plan 工具（create_plan / update_plan_item / edit_plan）的结果消息。 */
export function isPlanToolMessage(msg: AgentMessage): boolean {
  return msg.role === 'tool' && !!msg.toolResult && isPlanTool(msg.toolResult.toolName);
}

interface Props {
  kind?: ToolGroupKind;
  messages: readonly AgentMessage[];
  /** 搜索命中组内消息时强制展开，便于定位 */
  forceExpand?: boolean;
  matchedIds?: Set<string>;
  flashId?: string | null;
  /** Virtual lists render the members as independent rows. */
  headerOnly?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}

function ExplorationGroup({
  messages,
  forceExpand = false,
  matchedIds,
  flashId = null,
  headerOnly = false,
  expanded: controlledExpanded,
  onToggle,
}: Props) {
  const [localExpanded, setExpanded] = useState(forceExpand);
  const expanded = controlledExpanded ?? localExpanded;

  useEffect(() => {
    setExpanded(forceExpand);
  }, [forceExpand]);

  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-full">
        <button
          type="button"
          onClick={onToggle ?? (() => setExpanded((v) => !v))}
          aria-expanded={expanded}
          className="tool-summary-toggle flex max-w-full items-center gap-2 rounded px-1 text-[13px] leading-5 font-normal text-zinc-400 hover:text-zinc-300 transition-colors"
        >
          <svg
            aria-hidden="true"
            className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <ToolCallSummary messages={messages} />
        </button>
        {expanded && !headerOnly && (
          <div>
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
                  <ToolCallCard message={msg} autoExpand={forceExpand} />
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
