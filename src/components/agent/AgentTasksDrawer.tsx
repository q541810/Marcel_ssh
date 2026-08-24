import React from 'react';
import type { AgentTask } from '@/lib/types';
import { useTaskStore } from '@/stores/taskStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { getTaskVisualStatus, getActiveRunningTasks } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from './AgentStatusIndicator';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

interface AgentTasksDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const AgentTasksDrawer: React.FC<AgentTasksDrawerProps> = ({ open, onClose }) => {
  const presence = useAnimatedPresence(open);
  const tasks = useTaskStore((s) => s.tasks);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  const conversations = useConversationStore((s) => s.conversations);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  if (!presence.mounted) return null;

  const runningTasks = getActiveRunningTasks(tasks);

  const getSessionLabel = (sessionId: string) => {
    const session = sessions[sessionId];
    if (!session) return '未知会话';
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
    <>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/40 z-40 backdrop-blur-[2px] transition-opacity ${
          presence.phase === 'exit' ? 'animate-fadeOut' : 'animate-fadeIn'
        }`}
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <div
        onAnimationEnd={presence.onAnimationEnd}
        className={`absolute top-0 right-0 h-full w-80 max-w-[90vw] bg-zinc-950/95 backdrop-blur-xl border-l border-zinc-800 z-50 flex flex-col shadow-2xl ${
          presence.phase === 'exit' ? 'animate-slideOutRight' : 'animate-slideInRight'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80 bg-zinc-900/40">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">运行中的任务</span>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-full">
              {runningTasks.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {runningTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center text-zinc-500">
              <svg className="w-8 h-8 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-xs">暂无后台运行中的任务</p>
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
                  className={`group relative flex flex-col p-3 rounded-xl border transition-all cursor-pointer ${
                    isCurrent
                      ? 'bg-zinc-800/90 border-indigo-500/40 shadow-sm shadow-indigo-500/5'
                      : 'bg-zinc-900/60 border-zinc-800/80 hover:bg-zinc-800/70 hover:border-zinc-700/80'
                  }`}
                >
                  {/* Top Row: Tags + Status */}
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
                      <span className="text-xs font-medium text-zinc-300 truncate" title={sessionLabel}>
                        {sessionLabel}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <AgentStatusIndicator status={visualStatus} size="sm" showTooltip />
                      {task.status === 'waiting_approval' && (
                        <span className="text-[10px] text-amber-400 font-medium">待审批</span>
                      )}
                    </div>
                  </div>

                  {/* Title */}
                  <div className="text-xs font-semibold text-zinc-100 truncate mb-1">
                    {convTitle}
                  </div>

                  {/* Prompt preview */}
                  {task.prompt && (
                    <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                      {task.prompt}
                    </p>
                  )}

                  {/* Bottom info */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/50 text-[10px] text-zinc-500">
                    <span>
                      {task.createdAt ? new Date(task.createdAt).toLocaleTimeString() : ''}
                    </span>
                    <span className="text-indigo-400 group-hover:translate-x-0.5 transition-transform flex items-center gap-0.5">
                      点击查看
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
};
