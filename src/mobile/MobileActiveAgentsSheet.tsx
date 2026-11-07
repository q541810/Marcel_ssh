import React, { useEffect, useState } from 'react';
import MobileSheet from './ui/MobileSheet';
import type { AgentTask } from '@/lib/types';
import { useTaskStore } from '@/stores/taskStore';
import { useJobStore } from '@/stores/jobStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import { getTaskVisualStatus, getListedTasks } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import {
  canJumpToSession,
  getJobSessionLabel,
  getSessionLabel,
  type TaskCenterCatalog,
  taskStatusBadge,
} from '@/lib/taskCenterLabels';
import { ChevronRight } from 'lucide-react';

interface MobileActiveAgentsSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * 打开时停在哪个页签（入口侧决定，与桌面 `AgentTasksDrawer` 同名同义）：
   * 由「只有需要用户知道结局的作业」打开时别停在空的「Agent 任务」页。
   */
  initialTab?: 'agents' | 'jobs';
}

export default function MobileActiveAgentsSheet({
  open,
  onClose,
  initialTab,
}: MobileActiveAgentsSheetProps) {
  const [activeTab, setActiveTab] = useState<'agents' | 'jobs'>(initialTab ?? 'agents');
  const tasks = useTaskStore((s) => s.tasks);
  const jobs = useJobStore((s) => s.jobs);
  const killJob = useJobStore((s) => s.killJob);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  const conversations = useConversationStore((s) => s.conversations);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // 页签状态跨开关保留：每次打开按入口给的那一侧对齐。
  useEffect(() => {
    if (open && initialTab) setActiveTab(initialTab);
  }, [open, initialTab]);

  // Jobs 页签真正亮出来才记「已读」，与桌面 AgentTasksDrawer 同一口径：
  // interrupted 作业的警示胶囊只数未读的（见 taskCenterEntry），看过结局
  // 说明就该摘掉；开在 agents 页就关掉不算看过。
  const markInterruptedJobsRead = useJobStore((s) => s.markInterruptedJobsRead);
  useEffect(() => {
    if (open && activeTab === 'jobs') {
      markInterruptedJobsRead(Object.values(jobs));
    }
  }, [open, activeTab, jobs, markInterruptedJobsRead]);

  const runningTasks = getListedTasks(tasks);
  const jobList = Object.values(jobs).sort((a, b) => b.startedAtMillis - a.startedAtMillis);
  const runningJobs = jobList.filter((j) => j.status === 'running');

  // 会话标签与跳转守卫：与桌面 AgentTasksDrawer 共用 `lib/taskCenterLabels`
  // （含幽灵会话反查、哨兵值特判），同一份逻辑、同一套措辞。
  const catalog: TaskCenterCatalog = { sessions, connections, conversations, tasks };

  const getConversationTitle = (task: AgentTask) => {
    const conv = conversations[task.conversationId];
    if (conv?.title) return conv.title;
    return task.prompt
      ? task.prompt.length > 20
        ? `${task.prompt.slice(0, 20)}...`
        : task.prompt
      : "Agent 任务";
  };

  const handleJumpToTask = async (task: AgentTask) => {
    // 本机子任务（哨兵 sessionId）与幽灵会话（不在 sessionStore）都没有终端
    // 标签可切：守卫判定在 canJumpToSession（共享模块）。只切对话，不切终端
    // 会话，避免 setActiveSession 指向不存在的 id —— 过程一样看得到，会话标签
    // 在卡片上。与桌面 AgentTasksDrawer 同一口径。
    if (canJumpToSession(sessions, task, activeSessionId)) {
      setActiveSession(task.sessionId);
    }
    if (task.conversationId && task.conversationId !== activeConversationId) {
      await sessionConversationBindingManager.openConversation(task.conversationId);
    }
    onClose();
  };

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title="任务与作业中心"
      maxHeightClassName="max-h-[85dvh]"
    >
      <div className="flex border-b border-edge-subtle px-4 pt-1 gap-4 bg-surface/50">
        <button
          type="button"
          onClick={() => setActiveTab('agents')}
          className={`pb-2 text-meta font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'agents'
              ? 'border-indigo-500 text-indigo-400 font-semibold'
              : 'border-transparent text-fg-secondary'
          }`}
        >
          <span>Agent 任务</span>
          <span className="px-1.5 py-0.2 text-caption bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-full">
            {runningTasks.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('jobs')}
          className={`pb-2 text-meta font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'jobs'
              ? 'border-sky-500 text-sky-400 font-semibold'
              : 'border-transparent text-fg-secondary'
          }`}
        >
          <span>后台作业 (Jobs)</span>
          <span className="px-1.5 py-0.2 text-caption bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-full">
            {runningJobs.length}
          </span>
        </button>
      </div>

      <div className="space-y-2.5 p-3">
        {activeTab === 'agents' ? (
          runningTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-fg-tertiary">
              <p className="text-meta">暂无运行中的 Agent 任务</p>
            </div>
          ) : (
            runningTasks.map((task) => {
              const isSubTask = Boolean(task.parentTaskId);
              const sessionLabel = getSessionLabel(catalog, task);
              const convTitle = getConversationTitle(task);
              const isCurrent = task.conversationId === activeConversationId;
              const visualStatus = getTaskVisualStatus(task);

              return (
                <div
                  key={task.id}
                  onClick={() => void handleJumpToTask(task)}
                  className={`group flex flex-col p-3 rounded-xl border pressable ${
                    isCurrent
                      ? 'bg-surface-raised/90 border-indigo-500/40'
                      : 'bg-surface/70 border-edge-subtle/80 active:bg-state-soft'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isSubTask ? (
                        <span className="px-1.5 py-0.5 text-caption font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded flex-shrink-0">
                          {task.mode === "agent" ? "子任务 · 执行" : "子任务 · 调研"}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 text-caption font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 rounded flex-shrink-0">
                          主任务
                        </span>
                      )}
                      <span className="text-meta font-medium text-fg-secondary truncate">
                        {sessionLabel}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <AgentStatusIndicator status={visualStatus} size="sm" />
                      {(() => {
                          const badge = taskStatusBadge(task);
                          return badge && (
                            <span className={`text-caption font-medium ${badge.tone === 'amber' ? 'text-amber-400' : 'text-fg-tertiary'}`}>{badge.text}</span>
                          );
                        })()}
                    </div>
                  </div>

                  <div className="text-meta font-semibold text-fg truncate mb-1">
                    {convTitle}
                  </div>

                  {task.prompt && (
                    <p className="text-caption text-fg-secondary line-clamp-2 leading-relaxed">
                      {task.prompt}
                    </p>
                  )}

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-edge-subtle/50 text-caption text-fg-tertiary">
                    <span>
                      {task.createdAt ? new Date(task.createdAt).toLocaleTimeString() : ''}
                    </span>
                    <span className="text-indigo-400 flex items-center gap-0.5 font-medium">
                      点击跳转
                      <ChevronRight className="w-3 h-3" />
                    </span>
                  </div>
                </div>
              );
            })
          )
        ) : (
          jobList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-fg-tertiary">
              <p className="text-meta">暂无后台作业</p>
            </div>
          ) : (
            jobList.map((job) => {
              const sessionLabel = getJobSessionLabel(catalog, job.sessionId);
              const isRunning = job.status === 'running';
              // 上一次应用运行留下、随应用退出中断的作业：没有可终止的东西，
              // 也不会再有新输出——给用户一句解释，别让他以为还在跑。
              const isInterrupted = job.status === 'interrupted';

              return (
                <div
                  key={job.jobId}
                  className={`flex flex-col p-3 rounded-xl border ${
                    isRunning
                      ? 'bg-sky-950/20 border-sky-800/50'
                      : 'bg-surface/70 border-edge-subtle/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="px-1.5 py-0.5 text-caption font-mono font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded flex-shrink-0">
                        {job.jobId}
                      </span>
                      <span className="text-meta font-medium text-fg-secondary truncate">
                        {sessionLabel}
                      </span>
                    </div>
                    <span className={`text-caption font-medium px-1.5 py-0.5 rounded ${
                      isRunning
                        ? 'text-sky-400 bg-sky-950/60 border border-sky-800/50'
                        : job.status === 'completed'
                        ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-800/40'
                        : isInterrupted
                        ? 'text-amber-400 bg-amber-950/40 border border-amber-800/40'
                        : 'text-fg-secondary bg-surface-raised'
                    }`}>
                      {job.status}
                    </span>
                  </div>
                  <div className="text-meta font-medium text-fg truncate mb-1">
                    {job.description || job.command}
                  </div>
                  <div className="bg-black/40 rounded p-1.5 font-mono text-caption text-fg-secondary truncate mb-2">
                    $ {job.command}
                  </div>
                  {isInterrupted && (
                    <p className="text-caption text-amber-400/80 leading-relaxed mb-2">
                      上一次应用运行留下的作业：应用退出时通道就关闭了，之后的输出看不到；远端进程是否还在运行，要在服务器上确认。
                    </p>
                  )}
                  <div className="flex items-center justify-between pt-2 border-t border-edge-subtle/50 text-caption text-fg-tertiary">
                    <span>
                      输出: {job.totalOutputBytes} 字节
                      {job.detail ? ` · ${job.detail}` : ''}
                    </span>
                    {isRunning && (
                      <button
                        type="button"
                        onClick={() => void killJob(job.jobId)}
                        className="px-2 py-0.5 text-caption font-medium text-red-400 bg-red-950/40 border border-red-800/50 rounded pressable"
                      >
                        终止
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )
        )}
      </div>
    </MobileSheet>
  );
}

