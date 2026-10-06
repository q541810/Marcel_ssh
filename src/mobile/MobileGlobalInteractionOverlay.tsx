import { useCallback, useState, useEffect } from 'react';
import type { AgentTask } from '@/lib/types';
import { isLocalSessionId } from '@/lib/toolCatalog';
import { useTaskStore } from '@/stores/taskStore';
import { useInteractionStore } from '@/stores/interactionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import MobileApprovalSheet from '@/mobile/MobileApprovalSheet';
import MobileQuestionSheet from '@/mobile/MobileQuestionSheet';
import { InteractionFloatingCapsule } from '@/components/agent/InteractionFloatingCapsule';

/**
 * 「跳转」该跳到哪条 SSH 会话。
 *
 * - 远端交互：它自己的会话，原样用（空串 = 没有可跳的会话，保持旧行为）。
 * - 本机交互（`sessionId` 是哨兵值 —— 本机子 agent 里触发的审批 / 提问）：本机
 *   没有终端标签，但**派它的那个父 agent 有**（`local_subagent` 只对主 agent
 *   开放，禁止嵌套，所以父任务一定跑在一条真会话上）。跳到父 agent 所在的机器
 *   才是用户点「跳转」想看的东西：那条（子）对话的过程就在那台机器上。
 *   父任务记录缺失（重启残留等）就**不切会话**：宁可停在当前终端，也绝不把
 *   `activeSessionId` 设成哨兵 —— 那会把终端切到一条不存在的会话，整块空白、
 *   标签栏无一高亮，用户被扔进一个找不到的地方。
 *
 * 移动端与桌面各一份实现（两个 overlay 是平行实现），口径必须一致。
 *
 * 刻意**不导出**（只在组件内用）：本文件是组件文件，多一个非组件导出会让
 * react-refresh 的 fast refresh 失效（`react-refresh/only-export-components`），
 * 而它没有第二个消费方；行为由 `MobileGlobalInteractionOverlay.test.tsx` 从组件
 * 外部断言（真的渲染 → 收起 → 点「跳转」→ 看跳到哪条会话）。
 */
function interactionJumpSessionId(
  sessionId: string,
  taskId: string,
  tasks: Record<string, Pick<AgentTask, 'sessionId' | 'parentTaskId'>>,
): string | null {
  if (!isLocalSessionId(sessionId)) return sessionId || null;
  const own = tasks[taskId];
  const parent = own?.parentTaskId ? tasks[own.parentTaskId] : undefined;
  const parentSessionId = parent?.sessionId;
  if (!parentSessionId || isLocalSessionId(parentSessionId)) return null;
  return parentSessionId;
}

export default function MobileGlobalInteractionOverlay() {
  const current = useInteractionStore((s) => s.currentInteraction);
  const approve = useInteractionStore((s) => s.approve);
  const reject = useInteractionStore((s) => s.reject);
  const answerQuestion = useInteractionStore((s) => s.answerQuestion);
  const stopTask = useTaskStore((s) => s.stopTask);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const switchConversation = useConversationStore((s) => s.switchConversation);

  // 用户是否主动最小化了当前交互
  const [minimized, setMinimized] = useState(false);

  // 当交互变化（新请求到达）时，默认展开弹窗
  useEffect(() => {
    setMinimized(false);
  }, [current?.interactionId]);

  // 「当前就在这条上下文里」：远端交互比会话 + 对话两项；本机交互没有会话可比
  // （哨兵永远不等于 activeSessionId），只比对话 —— 否则用户明明正看着那条子
  // 对话，胶囊还在催他「跳转」到一个跳不过去的地方。
  const isCurrentContext =
    current != null &&
    activeConversationId === current.conversationId &&
    (isLocalSessionId(current.sessionId) || activeSessionId === current.sessionId);

  const handleNavigate = useCallback(() => {
    if (!current) return;
    const jumpSessionId = interactionJumpSessionId(
      current.sessionId,
      current.taskId,
      useTaskStore.getState().tasks,
    );
    if (jumpSessionId && activeSessionId !== jumpSessionId) {
      setActiveSession(jumpSessionId);
    }
    if (current.conversationId && activeConversationId !== current.conversationId) {
      void switchConversation(current.conversationId);
    }
    // 点击跳转后自动最小化弹窗，避免遮挡聊天内容
    setMinimized(true);
  }, [current, activeSessionId, activeConversationId, setActiveSession, switchConversation]);

  if (!current) return null;

  // 最小化展示状态：渲染右下角半透明悬浮胶囊
  if (minimized) {
    return (
      <InteractionFloatingCapsule
        interaction={current}
        onExpand={() => setMinimized(false)}
        onApprove={
          current.kind === 'approval' && current.approval
            ? () => {
                if (current.approval) {
                  void approve(current.taskId, current.approval.toolCallId);
                }
              }
            : undefined
        }
        onReject={
          current.kind === 'approval' && current.approval
            ? () => {
                if (current.approval) {
                  void reject(current.taskId, current.approval.toolCallId);
                }
              }
            : undefined
        }
        onNavigateToContext={handleNavigate}
        isCurrentContext={isCurrentContext}
      />
    );
  }

  if (current.kind === 'approval' && current.approval) {
    return (
      // key：审批切换必须重挂载，理由输入等内部状态不能从上一条审批漏进下一条
      <MobileApprovalSheet
        key={current.interactionId}
        toolCall={{
          id: current.approval.toolCallId,
          name: current.approval.toolName,
          arguments: current.approval.arguments,
          disposition: current.approval.disposition,
          reasons: current.approval.reasons,
          metadata: current.approval.metadata,
        }}
        open={true}
        onApprove={() => {
          if (current.approval) {
            void approve(current.taskId, current.approval.toolCallId);
          }
        }}
        onReject={(reason?: string) => {
          if (current.approval) {
            void reject(current.taskId, current.approval.toolCallId, reason);
          }
        }}
        onRejectAndStop={async (reason?: string) => {
          if (!current.approval) return;
          // 顺序要紧：先拒绝（理由要走交互队列送出去），再停任务。
          // 反过来的话 stopTask 会先把待审批请求按「拒绝但无理由」清掉，理由就丢了。
          await reject(current.taskId, current.approval.toolCallId, reason);
          await stopTask(current.taskId);
        }}
        sessionName={current.sessionName}
        conversationTitle={current.conversationTitle}
        isCurrentContext={isCurrentContext}
        onNavigateToContext={handleNavigate}
        queueLength={current.queueLength}
        onMinimize={() => setMinimized(true)}
      />
    );
  }

  if (current.kind === 'question' && current.question) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 pointer-events-auto shadow-2xl animate-fadeIn">
        {/* key：交互切换必须重挂载。面板内部题号/答案按首份 questions 定格，
            不重挂的话 2 题切 1 题会越界渲染崩掉整棵树（2026-10-06 线上爆炸） */}
        <MobileQuestionSheet
          key={current.interactionId}
          questionId={current.question.questionId}
          questions={current.question.questions}
          onSubmit={(_qid, answers) => {
            if (current.question) {
              void answerQuestion(current.taskId, current.question.questionId, answers);
            }
          }}
          onCancel={() => {
            if (current.question) {
              const empty = current.question.questions.map(() => ({ selected: [], custom: '' }));
              void answerQuestion(current.taskId, current.question.questionId, empty);
            }
          }}
          sessionName={current.sessionName}
          conversationTitle={current.conversationTitle}
          isCurrentContext={isCurrentContext}
          onNavigateToContext={handleNavigate}
          queueLength={current.queueLength}
          onMinimize={() => setMinimized(true)}
        />
      </div>
    );
  }

  return null;
}

