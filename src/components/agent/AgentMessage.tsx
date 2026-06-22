import { memo, useState, useEffect, useRef } from "react";
import type { AgentMessage as AgentMessageType } from "@/lib/types";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useSettingsStore } from "@/stores/settingsStore";
import { openExternalLink } from "@/lib/externalLinks";

interface Props {
  message: AgentMessageType;
  autoExpand?: boolean;
  rollbackDisabled?: boolean;
  onRollback?: (message: AgentMessageType) => void;
  onCopy?: (message: AgentMessageType) => void;
}

const MARKDOWN_CLASS =
  "text-[15px] leading-relaxed text-zinc-100 break-words prose prose-invert prose-sm max-w-none prose-p:my-0.5 prose-code:text-pink-300 prose-code:bg-zinc-900 prose-code:px-1 prose-code:py-0.5 prose-code:rounded-lg prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-a:text-indigo-400 prose-headings:my-2 prose-ul:my-0 prose-ol:my-0 prose-li:my-0 prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-400 prose-blockquote:italic";

// ─── Retry indicator: 倒计时 + 错误折叠 ───
// 后端发完 Retrying 事件就 sleep，前端基于消息 timestamp + retryTotalDelaySecs
// 自己算剩余秒数，区分"等待"和"正在重试"两个阶段。
function RetryIndicator({ message }: { message: AgentMessageType }) {
  const attempt = message.retryAttempt ?? 0;
  const maxAttempts = message.retryMaxAttempts ?? 0;
  const totalDelay = message.retryTotalDelaySecs ?? 0;
  const lastError = message.retryLastError ?? '';

  const startMs = new Date(message.timestamp).getTime();
  const endMs = startMs + totalDelay * 1000;

  const [remaining, setRemaining] = useState(() => {
    const r = (endMs - Date.now()) / 1000;
    return r > 0 ? r : 0;
  });
  const [errorExpanded, setErrorExpanded] = useState(false);
  const endMsRef = useRef(endMs);
  endMsRef.current = endMs;

  useEffect(() => {
    const tick = () => {
      const r = (endMsRef.current - Date.now()) / 1000;
      setRemaining(r > 0 ? r : 0);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, []);

  const waiting = remaining > 0;
  const remainingCeil = Math.ceil(remaining);

  // 错误展示：首行截断 80 字符
  const errorFirstLine = lastError.split('\n')[0] ?? '';
  const errorSummary = errorFirstLine.length > 80 ? errorFirstLine.slice(0, 80) + '…' : errorFirstLine;
  const hasMore = errorFirstLine.length > 80 || lastError.includes('\n');

  return (
    <div className="flex justify-center my-1">
      <div className="flex flex-col items-center gap-1 max-w-[90%]">
        <div
          className={`flex items-center gap-1.5 text-xs rounded-full px-3 py-1 border transition-colors ${
            waiting
              ? 'text-amber-400 bg-amber-400/10 border-amber-400/20'
              : 'text-sky-400 bg-sky-400/10 border-sky-400/20'
          }`}
        >
          {waiting ? (
            // 时钟图标：等待阶段
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 7v5l3 2" />
            </svg>
          ) : (
            // spinner：正在重试阶段
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {waiting ? (
            <span>
              {remainingCeil}s 后重试
              {maxAttempts > 0 && ` (${attempt}/${maxAttempts})`}
            </span>
          ) : (
            <span>
              正在重试请求{maxAttempts > 0 && ` (${attempt}/${maxAttempts})`}…
            </span>
          )}
        </div>
        {/* 错误信息：默认折叠，点击展开 */}
        {lastError && (
          <button
            type="button"
            onClick={() => hasMore && setErrorExpanded((v) => !v)}
            className={`text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors max-w-full text-left break-words [overflow-wrap:anywhere] ${
              hasMore ? 'cursor-pointer' : 'cursor-default'
            }`}
            title={hasMore ? (errorExpanded ? '点击折叠' : '点击展开完整错误') : undefined}
          >
            {errorExpanded ? lastError : errorSummary}
          </button>
        )}
      </div>
    </div>
  );
}

function AgentMessage({ message, autoExpand, rollbackDisabled, onRollback, onCopy }: Props) {
  const hideThinkingDisplay = useSettingsStore((s) => s.settings.hideThinkingDisplay);
  const [thinkingExpanded, setThinkingExpanded] = useState(autoExpand ?? false);
  useEffect(() => {
    setThinkingExpanded(!!autoExpand);
  }, [autoExpand]);

  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";
  const hasReasoning = !!message.reasoningContent && !hideThinkingDisplay;

  // Hide empty assistant messages without loading, tool calls, or visible reasoning
  if (
    !isUser &&
    !isSystem &&
    !isTool &&
    !message.isLoading &&
    !message.content &&
    !hasReasoning &&
    !message.toolCall
  ) {
    return null;
  }

  // ─── User message: right-aligned bubble ──
  if (isUser) {
    const sentAt = new Date(message.timestamp).toLocaleString();
    return (
      <div className="group flex justify-end my-1">
        <div className="flex max-w-[80%] flex-col items-end">
        <div className="max-w-full rounded-2xl rounded-tr-sm bg-zinc-700 px-4 py-2 text-[15px] leading-relaxed text-white whitespace-pre-wrap">
          {message.content}
        </div>
          <div className="mt-1 flex w-max max-w-full items-center justify-end gap-2 text-[11px] text-zinc-500 opacity-0 translate-y-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0 focus-within:opacity-100 focus-within:translate-y-0">
            <span className="min-w-0 truncate">
              {sentAt}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onRollback?.(message)}
                disabled={rollbackDisabled}
                className="p-1 rounded text-zinc-500 hover:text-amber-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={rollbackDisabled ? '任务运行中，暂不能撤回' : '撤回到这条消息'}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => onCopy?.(message)}
                className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                title="复制消息"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── System message ───
  if (isSystem) {
    if (message.isRetrying) {
      return <RetryIndicator message={message} />;
    }
    return (
      <div className="flex justify-center my-1">
        <div className="text-xs text-zinc-500 italic px-2 py-1 break-words [overflow-wrap:anywhere]">
          {message.content}
        </div>
      </div>
    );
  }

  // ─── Tool result: rendered via ToolCallCard, skip here ───
  if (isTool) {
    return null;
  }

  // ─── Assistant message ───
  return (
    <div className="flex justify-start my-1">
      <div className="max-w-[90%]">
        {/* Thinking / Reasoning foldable */}
        {hasReasoning && (
          <div className="mb-0.5">
            <button
              type="button"
              onClick={() => setThinkingExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg
                className={`w-3 h-3 transition-transform ${thinkingExpanded ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              <span>{message.isThinking ? "思考中" : "已思考"}</span>
              {message.isThinking && (
                <svg
                  className="animate-spin h-3 w-3"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              )}
            </button>
            {thinkingExpanded && (
              <div className="mt-1.5 pl-4 border-l-2 border-zinc-700 text-xs text-zinc-400 whitespace-pre-wrap break-words">
                {message.reasoningContent}
              </div>
            )}
          </div>
        )}

        {/* Main content */}
        {message.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <svg
              className="animate-spin h-4 w-4"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            <span>思考中...</span>
          </div>
        ) : !message.content ? (
          hasReasoning ? null : (
            <div className="text-sm text-zinc-500 italic">（无内容）</div>
          )
        ) : (
          <div className={MARKDOWN_CLASS}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                a: ({ href, children, ...props }) => (
                  <a
                    {...props}
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      if (href) openExternalLink(href);
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AgentMessage);
