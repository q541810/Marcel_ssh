import { useState } from "react";
import type { AgentMessage as AgentMessageType } from "@/lib/types";
import Markdown from "react-markdown";

interface Props {
  message: AgentMessageType;
}

const MARKDOWN_CLASS =
  "text-[15px] leading-relaxed text-zinc-100 whitespace-pre-wrap break-words prose prose-invert prose-sm max-w-none prose-p:my-1 prose-code:text-pink-300 prose-code:bg-zinc-900 prose-code:px-1 prose-code:py-0.5 prose-code:rounded-lg prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-a:text-indigo-400 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-400 prose-blockquote:italic";

const THINKING_MARKDOWN_CLASS =
  "text-xs text-zinc-400 whitespace-pre-wrap break-words prose prose-invert prose-xs max-w-none prose-p:my-0.5 prose-code:text-zinc-500 prose-code:bg-zinc-900/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-zinc-900/50 prose-pre:border prose-pre:border-zinc-800 prose-a:text-zinc-500 prose-headings:my-1 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-blockquote:border-l-zinc-700 prose-blockquote:text-zinc-500 prose-blockquote:italic";

export default function AgentMessage({ message }: Props) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";

  // Hide empty assistant messages without loading, tool calls, or reasoning
  if (
    !isUser &&
    !isSystem &&
    !isTool &&
    !message.isLoading &&
    message.content === "" &&
    !message.reasoningContent &&
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
  const hasReasoning = !!message.reasoningContent;

  return (
    <div className="flex justify-start my-1">
      <div className="max-w-[90%]">
        {/* Thinking / Reasoning foldable */}
        {hasReasoning && (
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setThinkingExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
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
              <span>{message.isThinking ? "已思考（进行中）" : "已思考"}</span>
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
