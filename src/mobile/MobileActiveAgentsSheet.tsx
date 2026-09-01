import React, { useState } from 'react';
import MobileSheet from './ui/MobileSheet';
import type { AgentTask, JobInfo } from '@/lib/types';
import { useTaskStore } from '@/stores/taskStore';
import { useJobStore } from '@/stores/jobStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { getTaskVisualStatus, getActiveRunningTasks } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import { ChevronRight } from 'lucide-react';

interface MobileActiveAgentsSheetProps {
  open: boolean;
  onClose: () => void;
}

export default function MobileActiveAgentsSheet({
  open,
  onClose,
}: MobileActiveAgentsSheetProps) {
  const [activeTab, setActiveTab] = useState<'agents' | 'jobs'>('agents');
  const tasks = useTaskStore((s) => s.tasks);
  const jobs = useJobStore((s) => s.jobs);
  const killJob = useJobStore((s) => s.killJob);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  const conversations = useConversationStore((s) => s.conversations);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const runningTasks = getActiveRunningTasks(tasks);
  const jobList = Object.values(jobs).sort((a, b) => b.startedAtMillis - a.startedAtMillis);
  const runningJobs = jobList.filter((j) => j.status === 'running');

  const getSessionLabel = (sessionId: string) => {
    const session = sessions[sessionId];
    if (!session) return '未知会话';
    const conn = session.configId ? connections.find((c) => c.id === session.configId) : null;
    return conn?.name || session.connectionId || sessionId;
  };

  // 作业专用会话标签：会话已关闭（前端 sessions 已删除，但后端作业仍保留）
  // 时，显示会话 ID + 关闭提示，不冒充未知会话。
  const getJobSessionLabel = (sessionId: string) => {
    const session = sessions[sessionId];
    if (!session) return `${sessionId}（该任务对应会话已关闭）`;
    const conn = session.configId ? connections.find((c) => c.id === session.configId) : null;
    return conn?.name || session.connectionId || sessionId;
  };

  const getConversationTitle = (task: AgentTask) => {
    const conv = conversations[task.conversationId];
    if (conv?.title) return conv.title;
    return task.prompt ? (task.prompt.length > 20 ? `${task.prompt.slice(0, 20)}...` : task.prompt) : 'Agent 任务';
  };

  const handleJumpToTask = async (task: AgentTask) => {
    if (task.sessionId && task.sessionId !== activeSessionId) {
      setActiveSession(task.sessionId);
    }
    if (task.conversationId && task.conversationId !== activeConversationId) {
      await switchConversation(task.conversationId);
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
      <div className="flex border-b border-zinc-800 px-4 pt-1 gap-4 bg-zinc-900/50">
        <button
          type="button"
          onClick={() => setActiveTab('agents')}
          className={`pb-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'agents'
              ? 'border-indigo-500 text-indigo-400 font-semibold'
              : 'border-transparent text-zinc-400'
          }`}
        >
          <span>Agent 任务</span>
          <span className="px-1.5 py-0.2 text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-full">
            {runningTasks.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('jobs')}
          className={`pb-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'jobs'
              ? 'border-sky-500 text-sky-400 font-semibold'
              : 'border-transparent text-zinc-400'
          }`}
        >
          <span>后台作业 (Jobs)</span>
          <span className="px-1.5 py-0.2 text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-full">
            {runningJobs.length}
          </span>
        </button>
      </div>

      <div className="space-y-2.5 p-3">
        {activeTab === 'agents' ? (
          runningTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-500">
              <p className="text-xs">暂无运行中的 Agent 任务</p>
            </div>
          ) : (
            runningTasks.map((task) => {
              const isSubTask = Boolean(task.parentTaskId);
              const sessionLabel = getSessionLabel(task.sessionId);
              const convTitle = getConversationTitle(task);
              const isCurrent = task.conversationId === activeConversationId;
              const visualStatus = getTaskVisualStatus(task);

              return (
                <div
                  key={task.id}
                  onClick={() => void handleJumpToTask(task)}
                  className={`group flex flex-col p-3 rounded-xl border transition-transform duration-100 active:scale-[0.98] ${
                    isCurrent
                      ? 'bg-zinc-800/90 border-indigo-500/40'
                      : 'bg-zinc-900/70 border-zinc-800/80 active:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isSubTask ? (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded flex-shrink-0">
                          子任务 · 调研
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 rounded flex-shrink-0">
                          主任务
                        </span>
                      )}
                      <span className="text-xs font-medium text-zinc-300 truncate">
                        {sessionLabel}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <AgentStatusIndicator status={visualStatus} size="sm" />
                      {task.status === 'waiting_approval' && (
                        <span className="text-[10px] text-amber-400 font-medium">待审批</span>
                      )}
                    </div>
                  </div>

                  <div className="text-xs font-semibold text-zinc-100 truncate mb-1">
                    {convTitle}
                  </div>

                  {task.prompt && (
                    <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                      {task.prompt}
                    </p>
                  )}

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/50 text-[10px] text-zinc-500">
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
            <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-500">
              <p className="text-xs">暂无后台作业</p>
            </div>
          ) : (
            jobList.map((job) => {
              const sessionLabel = getJobSessionLabel(job.sessionId);
              const isRunning = job.status === 'running';

              return (
                <div
                  key={job.jobId}
                  className={`flex flex-col p-3 rounded-xl border ${
                    isRunning
                      ? 'bg-sky-950/20 border-sky-800/50'
                      : 'bg-zinc-900/70 border-zinc-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded flex-shrink-0">
                        {job.jobId}
                      </span>
                      <span className="text-xs font-medium text-zinc-300 truncate">
                        {sessionLabel}
                      </span>
                    </div>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      isRunning
                        ? 'text-sky-400 bg-sky-950/60 border border-sky-800/50'
                        : job.status === 'completed'
                        ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-800/40'
                        : 'text-zinc-400 bg-zinc-800'
                    }`}>
                      {job.status}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-zinc-200 truncate mb-1">
                    {job.description || job.command}
                  </div>
                  <div className="bg-black/40 rounded p-1.5 font-mono text-[11px] text-zinc-400 truncate mb-2">
                    $ {job.command}
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800/50 text-[10px] text-zinc-500">
                    <span>输出: {job.totalOutputBytes} 字节</span>
                    {isRunning && (
                      <button
                        type="button"
                        onClick={() => void killJob(job.jobId)}
                        className="px-2 py-0.5 text-[11px] font-medium text-red-400 bg-red-950/40 border border-red-800/50 rounded active:scale-95 transition-all"
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

