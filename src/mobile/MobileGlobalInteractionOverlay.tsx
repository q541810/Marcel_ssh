import { useCallback, useState, useEffect } from 'react';
import type { AgentTask } from '@/lib/types';
import { isLocalSessionId } from '@/lib/toolCatalog';
import { useTaskStore } from '@/stores/taskStore';
import { useInteractionStore } from '@/stores/interactionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import MobileApprovalSheet from '@/mobile/MobileApprovalSheet';
import MobileQuestionBar from '@/mobile/MobileQuestionBar';
import { requestMobileTab } from '@/mobile/tabs';
import { useVisibleConversationIds } from '@/stores/visibleTranscriptStore';
import { shouldShowQuestionInline } from '@/lib/questionPlacement';
import { requestQuestionTextJump } from '@/stores/messageJumpStore';
import { InteractionFloatingCapsule } from '@/components/agent/InteractionFloatingCapsule';
import { openRiskRule } from '@/lib/riskRuleNav';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatInteractionSessionLabel } from '@/lib/privacy';

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
  const stopTask = useTaskStore((s) => s.stopTask);
  const privacyMode = usePrivacyMode();

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const activeConversationId = useConversationStore((s) => s.activeConversationId);

  // 提问所属对话正显示在聊天页里 → 已内联在聊天末尾（InlineQuestion），这里不画任何东西。
  const visibleConversationIds = useVisibleConversationIds();
  const questionInline = shouldShowQuestionInline(current, visibleConversationIds);

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
      void sessionConversationBindingManager.openConversation(current.conversationId);
    }
    if (current.kind === 'question' && current.question) {
      // 切到聊天页，并在对话显示出来后落到提问前那段结论的开头
      requestMobileTab('agent');
      requestQuestionTextJump(current.conversationId, current.question.questionId);
    }
    // 点击跳转后自动最小化弹窗，避免遮挡聊天内容
    setMinimized(true);
  }, [current, activeSessionId, activeConversationId, setActiveSession]);

  if (!current || questionInline) return null;

  // 提问：不再是盖住聊天的上拉面板。不在聊天页时只留一条提醒条，点它回到聊天页作答。
  if (current.kind === 'question' && current.question) {
    return (
      <MobileQuestionBar
        conversationTitle={current.conversationTitle}
        sessionName={formatInteractionSessionLabel(current.sessionTarget, privacyMode)}
        questionCount={current.question.questions.length}
        queueLength={current.queueLength}
        onOpen={() => handleNavigate()}
      />
    );
  }

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
          ruleIds: current.approval.ruleIds,
        }}
        onOpenRiskRule={(ruleId) => {
          // 先收起面板（不作答），再去设置里定位那条规则；审批仍挂在悬浮胶囊上。
          setMinimized(true);
          openRiskRule(ruleId);
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
        sessionName={formatInteractionSessionLabel(current.sessionTarget, privacyMode)}
        conversationTitle={current.conversationTitle}
        isCurrentContext={isCurrentContext}
        onNavigateToContext={handleNavigate}
        queueLength={current.queueLength}
        onMinimize={() => setMinimized(true)}
      />
    );
  }

  return null;
}

