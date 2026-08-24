import React from 'react';
import MobileSheet from './ui/MobileSheet';
import type { AgentTask } from '@/lib/types';
import { useTaskStore } from '@/stores/taskStore';
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
  const tasks = useTaskStore((s) => s.tasks);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  const conversations = useConversationStore((s) => s.conversations);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

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
    <MobileSheet
      open={open}
      onClose={onClose}
      title={`运行中的任务 (${runningTasks.length})`}
      maxHeightClassName="max-h-[85dvh]"
    >
      <div className="space-y-2.5 p-3">
        {runningTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-500">
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
                className={`group flex flex-col p-3 rounded-xl border transition-transform duration-100 active:scale-[0.98] ${
                  isCurrent
                    ? 'bg-zinc-800/90 border-indigo-500/40'
                    : 'bg-zinc-900/70 border-zinc-800/80 active:bg-zinc-800'
                }`}
              >
                {/* Top Row */}
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

                {/* Footer */}
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
        )}
      </div>
    </MobileSheet>
  );
}
