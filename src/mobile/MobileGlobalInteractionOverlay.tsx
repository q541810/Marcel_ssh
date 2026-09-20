import { useCallback, useState, useEffect } from 'react';
import { useTaskStore } from '@/stores/taskStore';
import { useInteractionStore } from '@/stores/interactionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import MobileApprovalSheet from '@/mobile/MobileApprovalSheet';
import MobileQuestionSheet from '@/mobile/MobileQuestionSheet';
import { InteractionFloatingCapsule } from '@/components/agent/InteractionFloatingCapsule';

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

  const isCurrentContext =
    current != null &&
    activeSessionId === current.sessionId &&
    activeConversationId === current.conversationId;

  const handleNavigate = useCallback(() => {
    if (!current) return;
    if (current.sessionId && activeSessionId !== current.sessionId) {
      setActiveSession(current.sessionId);
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
      <MobileApprovalSheet
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
        <MobileQuestionSheet
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

