import { useCallback, useState, useEffect } from 'react';
import { useInteractionStore } from '@/stores/interactionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import ApprovalDialog from '@/components/agent/ApprovalDialog';
import QuestionPanel from '@/components/agent/QuestionPanel';
import { InteractionFloatingCapsule } from './InteractionFloatingCapsule';
import { flyToInteractionCapsule } from '@/stores/capsuleFlyAnimation';

export default function GlobalInteractionOverlay() {
  const current = useInteractionStore((s) => s.currentInteraction);
  const approve = useInteractionStore((s) => s.approve);
  const reject = useInteractionStore((s) => s.reject);
  const answerQuestion = useInteractionStore((s) => s.answerQuestion);

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

  const handleNavigate = useCallback((e?: React.MouseEvent) => {
    if (!current) return;
    if (current.sessionId && activeSessionId !== current.sessionId) {
      setActiveSession(current.sessionId);
    }
    if (current.conversationId && activeConversationId !== current.conversationId) {
      void switchConversation(current.conversationId);
    }
    // 触发飞入动画并自动最小化弹窗
    const origin = e ? { x: e.clientX, y: e.clientY } : undefined;
    flyToInteractionCapsule(origin);
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
      <ApprovalDialog
        toolCall={{
          id: current.approval.toolCallId,
          name: current.approval.toolName,
          arguments: current.approval.arguments,
          riskLevel: current.approval.riskLevel,
          reasons: current.approval.reasons,
          metadata: current.approval.metadata,
        }}
        onApprove={() => {
          if (current.approval) {
            void approve(current.taskId, current.approval.toolCallId);
          }
        }}
        onReject={() => {
          if (current.approval) {
            void reject(current.taskId, current.approval.toolCallId);
          }
        }}
        open={true}
        onClose={() => {
          if (current.approval) {
            void reject(current.taskId, current.approval.toolCallId);
          }
        }}
        sessionName={current.sessionName}
        conversationTitle={current.conversationTitle}
        isCurrentContext={isCurrentContext}
        onNavigateToContext={handleNavigate}
        queueLength={current.queueLength}
        onMinimize={(e) => {
          const origin = e ? { x: e.clientX, y: e.clientY } : undefined;
          flyToInteractionCapsule(origin);
          setMinimized(true);
        }}
      />
    );
  }

  if (current.kind === 'question' && current.question) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center pointer-events-none animate-fadeIn">
        {/* 底部居中限宽：保持 bottom-sheet 语义，但宽度封顶不再横贯全屏
            （全宽下选项按钮被拉得无法使用）。pointer-events-auto 只让
            面板本身可交互，两侧留白不拦截点击。 */}
        <div className="pointer-events-auto w-full max-w-2xl px-3 pb-3 sm:px-4 sm:pb-5 drop-shadow-2xl">
          <QuestionPanel
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
            onMinimize={(e) => {
              const origin = e ? { x: e.clientX, y: e.clientY } : undefined;
              flyToInteractionCapsule(origin);
              setMinimized(true);
            }}
          />
        </div>
      </div>
    );
  }

  return null;
}

