import { useState, useEffect } from "react";
import type { AgentMessage as AgentMessageType } from "@/lib/types";
import Markdown from "react-markdown";
import { useSettingsStore } from "@/stores/settingsStore";

interface Props {
  message: AgentMessageType;
  autoExpand?: boolean;
}

const MARKDOWN_CLASS =
  "text-[15px] leading-relaxed text-zinc-100 break-words prose prose-invert prose-sm max-w-none prose-p:my-0.5 prose-code:text-pink-300 prose-code:bg-zinc-900 prose-code:px-1 prose-code:py-0.5 prose-code:rounded-lg prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-a:text-indigo-400 prose-headings:my-2 prose-ul:my-0 prose-ol:my-0 prose-li:my-0 prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-400 prose-blockquote:italic";

const THINKING_MARKDOWN_CLASS =
  "text-xs text-zinc-400 break-words prose prose-invert prose-xs max-w-none prose-p:my-0.5 prose-code:text-zinc-500 prose-code:bg-zinc-900/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-zinc-900/50 prose-pre:border prose-pre:border-zinc-800 prose-a:text-zinc-500 prose-headings:my-1 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-blockquote:border-l-zinc-700 prose-blockquote:text-zinc-500 prose-blockquote:italic";

export default function AgentMessage({ message, autoExpand }: Props) {
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
    return (
      <div className="flex justify-end my-1">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-zinc-700 px-4 py-2 text-[15px] leading-relaxed text-white whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  // ─── System message ───
  if (isSystem) {
    return (
      <div className="flex justify-center my-1">
        <div className="text-xs text-zinc-500 italic px-2 py-1">
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
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
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
              <div
                className={`mt-1.5 pl-4 border-l-2 border-zinc-700 ${THINKING_MARKDOWN_CLASS}`}
              >
                <Markdown>{message.reasoningContent}</Markdown>
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
            <Markdown>{message.content}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
