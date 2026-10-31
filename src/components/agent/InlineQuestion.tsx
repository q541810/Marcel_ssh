import { useEffect, useRef } from 'react';
import { useInteractionStore } from '@/stores/interactionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { requestQuestionTextJump } from '@/stores/messageJumpStore';
import { resolveQuestionTextMessage } from '@/lib/questionJump';
import type { AgentMessage } from '@/lib/types';
import InlineQuestionCard from './InlineQuestionCard';
import MobileQuestionSheet from '@/mobile/MobileQuestionSheet';

const EMPTY: AgentMessage[] = [];

/** questionId → 已经自动定位到哪里了：'card' = 仅滚到卡片；'text' = 已跳到上文。 */
const autoPlaced = new Map<string, 'card' | 'text'>();

/**
 * 内联提问宿主：挂在对话消息流末尾（`AgentTranscript` 里，桌面手机同一处）。
 * 只在当前待答的提问属于本对话时渲染；是否内联由「本对话正显示在可见面板里」决定，
 * 这个组件存在于面板里就意味着可见（`questionPlacement` 与全局浮层读同一份登记）。
 */
export default function InlineQuestion({
  conversationId, mobile,
}: { conversationId: string; mobile: boolean }) {
  const current = useInteractionStore((s) => s.currentInteraction);
  if (!current || current.kind !== 'question' || !current.question) return null;
  if (current.conversationId !== conversationId) return null;
  return <ActiveInlineQuestion key={current.interactionId} conversationId={conversationId} mobile={mobile} />;
}

function ActiveInlineQuestion({ conversationId, mobile }: { conversationId: string; mobile: boolean }) {
  const current = useInteractionStore((s) => s.currentInteraction)!;
  const answerQuestion = useInteractionStore((s) => s.answerQuestion);
  const messages = useConversationStore((s) => s.messages[conversationId] ?? EMPTY);
  const question = current.question!;
  const questionId = question.questionId;
  const hasText = resolveQuestionTextMessage(messages, questionId) !== null;
  const cardRef = useRef<HTMLDivElement>(null);

  // 新提问到达：优先把「提问前那段结论」的开头摆进视野（卡片就在下面）；没有上文才滚到卡片。
  // 每个提问只自动定位一次（有上文后可从 'card' 升级到 'text'），用户之后自己滚动不被打扰。
  useEffect(() => {
    const placed = autoPlaced.get(questionId);
    if (placed === 'text') return;
    if (hasText) {
      autoPlaced.set(questionId, 'text');
      requestQuestionTextJump(conversationId, questionId);
    } else if (!placed) {
      autoPlaced.set(questionId, 'card');
      cardRef.current?.scrollIntoView?.({ block: 'end' });
    }
  }, [conversationId, questionId, hasText]);

  const onSubmit = (_qid: string, answers: Parameters<typeof answerQuestion>[2]) => {
    void answerQuestion(current.taskId, questionId, answers);
  };
  const onJump = hasText
    ? (anchor?: string) => requestQuestionTextJump(conversationId, questionId, anchor)
    : undefined;

  return (
    <div ref={cardRef}>
      {mobile ? (
        <MobileQuestionSheet
          questionId={questionId}
          questions={question.questions}
          onSubmit={onSubmit}
          queueLength={current.queueLength}
          onJump={onJump}
          source={question.sourceSubagent}
        />
      ) : (
        <InlineQuestionCard
          questionId={questionId}
          questions={question.questions}
          onSubmit={onSubmit}
          queueLength={current.queueLength}
          onJump={onJump}
          source={question.sourceSubagent}
        />
      )}
    </div>
  );
}
