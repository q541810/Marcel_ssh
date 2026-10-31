import { memo, useContext } from 'react';
import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { Check, CircleHelp, MinusCircle } from 'lucide-react';

import { useInteractionStore } from '@/stores/interactionStore';
import { useVisibleConversationIds } from '@/stores/visibleTranscriptStore';
import { requestQuestionTextJump } from '@/stores/messageJumpStore';
import { normalizeHeadingText, resolveQuestionTextMessage } from '@/lib/questionJump';
import { shouldShowQuestionInline } from '@/lib/questionPlacement';
import { summarizeAnswers } from '@/lib/questionAnswerSummary';
import { completeQuestionSource, readSourceSubagentId } from '@/lib/subagentNav';
import { useConversationStore } from '@/stores/conversationStore';
import { MessageJumpContext } from './messageJumpContext';
import { QuestionSourceLine } from './QuestionSourceLine';
import { QuestionJumpButton } from './QuestionJumpButton';
import type { ToolViewProps } from './toolViews';

/** 提问参数里各题的 anchor（持久化的是模型原文，这里归一化；去重、去空）。 */
function anchorsOf(args: Record<string, unknown> | undefined): string[] {
  const qs = args?.questions;
  if (!Array.isArray(qs)) return [];
  const out: string[] = [];
  for (const q of qs) {
    const a = typeof (q as { anchor?: unknown })?.anchor === 'string' ? normalizeHeadingText((q as { anchor: string }).anchor) : '';
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * `ask_user` 在消息流里的一行记录（注册在 toolViews）。
 * - 待回答：提问正以内联卡片显示时这里不占位（卡片就是它）；提问在别处（全局浮层）时
 *   留一行淡色「等待你的回答」，让这条对话自己也交代得清。
 * - 已回答：内联卡片提交后原地收成一行「已回答：…」（卡片消失处正是这行出现处）。
 * 有上文可跳时带跳转按钮：每个带 anchor 的问题一个，否则整条一个。
 */
function QuestionRecord({ message, grouped }: ToolViewProps) {
  const tr = message.toolResult;
  const toolCallId = tr?.toolCallId ?? '';
  const scope = useContext(MessageJumpContext);
  const visibleIds = useVisibleConversationIds();
  const pending = useInteractionStore((s) => {
    const c = s.currentInteraction;
    return c?.kind === 'question' && c.question?.questionId === toolCallId ? c : null;
  });
  const sourceId = readSourceSubagentId(tr?.arguments);
  const sourceTitle = useConversationStore((s) => (sourceId ? s.conversations[sourceId]?.title : undefined));
  const sourceMessages = useConversationStore((s) => (sourceId ? s.messages[sourceId] : undefined));
  const source = sourceId ? completeQuestionSource(sourceId, sourceTitle, sourceMessages) : null;
  const inline = shouldShowQuestionInline(pending, visibleIds);
  const waiting = !!message.isExecuting;
  // 参数还在撰写（提问尚未发出）也不占位：那段时间由「正在撰写」状态条代表
  if (waiting && (inline || message.isComposing)) return null;
  const mobile = isMobilePlatform(collectPlatformHints());

  const canJump = !!scope && resolveQuestionTextMessage(scope.messagesRef.current, toolCallId) !== null;
  const anchors = anchorsOf(tr?.arguments);
  const jump = (anchor?: string) => scope && requestQuestionTextJump(scope.conversationId, toolCallId, anchor);

  let icon = <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />;
  let label: string;
  if (waiting) {
    icon = <CircleHelp className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />;
    label = '等待你的回答';
  } else {
    const summary = summarizeAnswers(tr?.result ?? '', tr?.success !== false);
    if (summary.state === 'skipped') {
      icon = <MinusCircle className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />;
      label = '已跳过提问';
    } else {
      label = `已回答：${summary.text}`;
    }
  }

  return (
    <div className={`flex min-w-0 justify-start ${grouped ? 'pl-3' : ''}`}>
      <div data-testid="question-record" className="min-w-0 max-w-full px-1 py-1 text-[13px] leading-5 text-zinc-400">
        <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex-shrink-0">{icon}</span>
          <span className="min-w-0 max-w-full truncate" title={label}>{label}</span>
          {canJump && (anchors.length > 0
            ? anchors.map((a) => <QuestionJumpButton key={a} mobile={mobile} anchor={a} onJump={() => jump(a)} />)
            : <QuestionJumpButton mobile={mobile} onJump={() => jump()} />)}
        </div>
        {source && <QuestionSourceLine source={source} mobile={mobile} className="pl-[22px]" />}
      </div>
    </div>
  );
}

export default memo(QuestionRecord) as (props: ToolViewProps) => JSX.Element | null;
