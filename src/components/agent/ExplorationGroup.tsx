import { memo, useState, useEffect, useMemo } from 'react';
import type { AgentMessage } from '@/lib/types';
import ToolCallCard, { isPlanTool } from './ToolCallCard';
import { summarizeWebToolGroup } from '@/lib/webToolStatus';

export type ToolGroupKind = 'exploration' | 'plan';

export const EXPLORATION_TOOLS = ['web_search', 'http_get', 'read_file', 'search_files', 'list_directory', 'system_info'];

export function isExplorationTool(msg: AgentMessage): boolean {
  if (msg.role === 'tool' && msg.toolResult) {
    return EXPLORATION_TOOLS.includes(msg.toolResult.toolName);
  }
  return false;
}

/** plan 工具（create_plan / update_plan_item / edit_plan）的结果消息。 */
export function isPlanToolMessage(msg: AgentMessage): boolean {
  return msg.role === 'tool' && !!msg.toolResult && isPlanTool(msg.toolResult.toolName);
}

interface Props {
  kind?: ToolGroupKind;
  messages: AgentMessage[];
  autoExpand?: boolean;
  /** 搜索命中组内消息时强制展开，便于定位 */
  forceExpand?: boolean;
  matchedIds?: Set<string>;
  flashId?: string | null;
}

function GroupLabel({ kind, count }: { kind: ToolGroupKind; count: number }) {
  const countEl = (
    <span
      key={count}
      className="inline-block min-w-[1ch] text-right text-zinc-500 animate-exploration-count"
    >
      {count}
    </span>
  );
  if (kind === 'plan') {
    return (
      <>
        <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
        <span className="text-zinc-300">计划</span>
        <span className="text-zinc-500"> </span>
        {countEl}
        <span className="text-zinc-500"> 次</span>
      </>
    );
  }
  return (
    <>
      <span className="text-zinc-300">已探索</span>
      <span className="text-zinc-500"> </span>
      {countEl}
      <span className="text-zinc-500"> 次读取</span>
    </>
  );
}

function ExplorationGroup({
  kind = 'exploration',
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

  // 折叠态只显示「已探索 N 次读取」，联网工具的降级/被网站拦截标记会随之消失。
  // 这里把组内异常汇总到分组标题上，保证折叠时也不会漏掉"这次其实是降级/被拦"。
  const webSummary = useMemo(
    () =>
      summarizeWebToolGroup(
        messages.flatMap((msg) =>
          msg.role === 'tool' && msg.toolResult
            ? [{ toolName: msg.toolResult.toolName, metadata: msg.toolResult.metadata }]
            : [],
        ),
      ),
    [messages],
  );

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
          <span className="flex items-center gap-1 text-sm">
            <GroupLabel kind={kind} count={messages.length} />
          </span>
          {webSummary.degraded > 0 && (
            <span
              className="ml-1 flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-md font-medium bg-amber-500/10 text-amber-300"
              title={`组内有 ${webSummary.degraded} 次联网调用发生了降级（未使用设置指定的后端），展开可查看原因`}
            >
              含降级
            </span>
          )}
          {webSummary.blocked > 0 && (
            <span
              className="ml-1 flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-md font-medium bg-amber-500/10 text-amber-300"
              title={`组内有 ${webSummary.blocked} 次联网调用被网站的人机验证拦下，展开可查看详情`}
            >
              含网站拦截
            </span>
          )}
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
