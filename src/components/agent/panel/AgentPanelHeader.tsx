import { useMemo, useState } from "react";
import { useJobStore } from "@/stores/jobStore";
import { taskCenterEntry } from "@/stores/agentStatusSelectors";
import { AgentStatusIndicator } from "../AgentStatusIndicator";
import { ContextMeterRing } from "../ContextMeterRing";
import { TokenUsagePanel } from "../TokenUsagePanel";
import MultiHostPicker from "../MultiHostPicker";
import { contextMeterView, formatPercent } from "@/lib/tokenUsage";
import type { ConversationUsageView } from "@/lib/tokenUsage";
import type { AgentTask } from "@/lib/types";

type AgentPanelHeaderProps = {
  /** 当前会话的 token 用量读数（useAgent.activeUsageView）。 */
  activeUsageView: ConversationUsageView | null;
  tasks: Record<string, AgentTask>;
  activeConversationId: string | null;
  canInteract: boolean;
  onNewConversation: () => void;
  onHistoryClick: () => void;
  onOpenTaskCenter: (tab: "agents" | "jobs") => void;
};

/** Agent 面板头部：占用环入口、任务/作业中心胶囊、多机选择器与新建/历史按钮。 */
export function AgentPanelHeader({
  activeUsageView,
  tasks,
  activeConversationId,
  canInteract,
  onNewConversation,
  onHistoryClick,
  onOpenTaskCenter,
}: AgentPanelHeaderProps) {
  const [tokenPopoverOpen, setTokenPopoverOpen] = useState(false);
  const jobs = useJobStore((s) => s.jobs);
  // 占用环读数（百分比 / 未配置窗口的降级都由 `lib/tokenUsage.ts` 定，
  // 与移动端共用同一份口径）
  const meter = contextMeterView(activeUsageView?.usage, activeUsageView?.windowTokens);
  // 任务与作业中心入口的判定与内容（与移动端共用一份，见 taskCenterEntry）
  const taskCenter = useMemo(
    () => taskCenterEntry(tasks, jobs, activeConversationId ?? null),
    [tasks, jobs, activeConversationId],
  );

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <h2 className="text-sm font-semibold text-zinc-200">智能助手</h2>
          <div className="relative">
            <button
              type="button"
              onClick={() => setTokenPopoverOpen((v) => !v)}
              className={`flex h-5 w-5 items-center justify-center rounded-full transition-colors ${
                tokenPopoverOpen ? 'bg-indigo-600/30' : 'hover:bg-zinc-700/70'
              }`}
              title={
                meter.percent != null
                  ? `上下文占用 ${formatPercent(meter.percent)}%`
                  : meter.windowTokens === 0
                    ? 'Token 用量（未配置上下文窗口）'
                    : 'Token 用量'
              }
              aria-label="Token 用量"
              aria-expanded={tokenPopoverOpen}
            >
              <ContextMeterRing percent={meter.percent} />
            </button>
            {tokenPopoverOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setTokenPopoverOpen(false)}
              />
              {/* `text-xs` 是这块面板的字号基准：内部尺寸都用 em 相对它算，
                  移动端那张 sheet 用 text-sm，两端各自贴合各自的字号体系 */}
              <div className="absolute top-full left-0 mt-2 w-64 text-xs bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl z-50 p-3 animate-fadeIn">
                <div className="mb-2 border-b border-zinc-700 pb-1.5 text-xs font-semibold text-zinc-300">
                  Token 用量
                </div>
                <TokenUsagePanel
                  usage={activeUsageView?.usage}
                  windowTokens={activeUsageView?.windowTokens ?? 0}
                />
              </div>
            </>
          )}
          </div>
        </div>

        {/* 计数胶囊：并发任务 > 1、运行中任务在别的对话、有后台作业在跑，
            或**只有**需要用户知道结局的作业（重启恢复出来的 interrupted，
            那种状态下没有任何 running，唯一的入口就是这里）。 */}
        {taskCenter.visible && (
          <button
            type="button"
            onClick={() => {
              onOpenTaskCenter(taskCenter.initialTab);
            }}
            className={`flex items-center gap-1.5 px-2 py-0.5 active:scale-95 border rounded-full text-[11px] font-medium transition-all animate-fadeIn ${
              taskCenter.runningTasks.length === 0 && taskCenter.runningJobs.length === 0
                ? 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-300'
                : taskCenter.runningJobs.length > 0
                  ? 'bg-sky-500/10 hover:bg-sky-500/20 border-sky-500/30 text-sky-300'
                  : 'bg-indigo-500/10 hover:bg-indigo-500/20 border-indigo-500/30 text-indigo-300'
            }`}
            title={
              taskCenter.runningTasks.length === 0 && taskCenter.runningJobs.length === 0
                ? '有上次运行留下的作业：结局未知，点开查看'
                : '查看所有运行中的 Agent 任务与后台作业'
            }
          >
            {taskCenter.runningTasks.length === 0 && taskCenter.runningJobs.length === 0 ? (
              <svg
                className="w-3 h-3 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            ) : (
              <AgentStatusIndicator status="running" size="xs" />
            )}
            <span>
              {taskCenter.runningTasks.length > 0 && `${taskCenter.runningTasks.length} 个任务`}
              {taskCenter.runningTasks.length > 0 && taskCenter.runningJobs.length > 0 && ' · '}
              {taskCenter.runningJobs.length > 0 && `${taskCenter.runningJobs.length} 个后台作业`}
              {taskCenter.runningTasks.length === 0 && taskCenter.runningJobs.length === 0 &&
                `${taskCenter.attentionJobs.length} 个作业已中断`}
            </span>
            <svg className="w-2.5 h-2.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        {/* 多机操控：目标机器选择器（当前机锁定置顶 + 可跨机目标；桌面恒渲染） */}
        <MultiHostPicker />
        <button
          type="button"
          onClick={onNewConversation}
          disabled={!canInteract}
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="新建会话"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={onHistoryClick}
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
          title="历史会话"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
