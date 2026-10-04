type SubconversationBarProps = {
  subAgentMode: "plan" | "agent";
  isLocal: boolean;
  title: string;
  onBack: () => void;
};

/** 子agent对话的输入区替换条：不能输入，只提供「返回主对话」与派发信息。 */
export function SubconversationBar({
  subAgentMode,
  isLocal,
  title,
  onBack,
}: SubconversationBarProps) {
  return (
    <div className="p-3 border-t border-zinc-800">
      <div className="flex items-center gap-3 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 flex-shrink-0 text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          返回主对话
        </button>
        <div className="flex-1 min-w-0 border-l border-zinc-700/50 pl-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
            {/* 本机子任务（local_subagent）：这条子对话在用户这台电脑上跑，
                没有 SSH 会话。不标的话用户会以为它跑在某台服务器上。 */}
            {isLocal && (
              <span className="flex-shrink-0 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                本机
              </span>
            )}
            <span className="min-w-0 truncate">
              {subAgentMode === "agent" ? "子agent执行" : "子agent调研"} ·{" "}
              {title}
            </span>
          </div>
          <div className="text-[11px] text-zinc-600 mt-0.5">
            {subAgentMode === "agent"
              ? "此对话由主 Agent 派发，用于读写执行，不支持输入"
              : "此对话由主 Agent 派发，仅用于只读调研，不支持输入"}
          </div>
        </div>
      </div>
    </div>
  );
}
