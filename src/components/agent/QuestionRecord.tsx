import { memo } from 'react';
import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { Check, CircleHelp, MinusCircle } from 'lucide-react';

import { summarizeAnswers } from '@/lib/questionAnswerSummary';
import { completeQuestionSource, readSourceSubagentId } from '@/lib/subagentNav';
import { useConversationStore } from '@/stores/conversationStore';
import { QuestionSourceLine } from './QuestionSourceLine';
import type { ToolViewProps } from './toolViews';

/**
 * `ask_user` 在消息流里的一行记录（注册在 toolViews）。
 * - 待回答：提问在全局浮层里，这里留一行灰色「等待你的回答」，让这条对话自己也交代得清。
 * - 已回答：浮层提交后原地收成一行「已回答：…」。
 * 颜色一律中性：这是一行历史记录。
 */
function QuestionRecord({ message, grouped }: ToolViewProps) {
  const tr = message.toolResult;
  const sourceId = readSourceSubagentId(tr?.arguments);
  const sourceTitle = useConversationStore((s) => (sourceId ? s.conversations[sourceId]?.title : undefined));
  const sourceMessages = useConversationStore((s) => (sourceId ? s.messages[sourceId] : undefined));
  const source = sourceId ? completeQuestionSource(sourceId, sourceTitle, sourceMessages) : null;
  const waiting = !!message.isExecuting;
  // 参数还在撰写（提问尚未发出）也不占位：那段时间由「正在撰写」状态条代表
  if (waiting && message.isComposing) return null;
  const mobile = isMobilePlatform(collectPlatformHints());

  let icon = <Check className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />;
  let label: string;
  if (waiting) {
    icon = <CircleHelp className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />;
    label = '等待你的回答';
  } else {
    const summary = summarizeAnswers(tr?.result ?? '', tr?.success !== false);
    if (summary.state === 'skipped') {
      icon = <MinusCircle className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />;
      label = '已跳过提问';
    } else {
      label = `已回答：${summary.text}`;
    }
  }

  return (
    <div className={`flex min-w-0 justify-start ${grouped ? 'pl-3' : ''}`}>
      <div data-testid="question-record" className="min-w-0 max-w-full px-1 py-1 text-body leading-5 text-fg-secondary">
        <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex-shrink-0">{icon}</span>
          <span className="min-w-0 max-w-full truncate" title={label}>{label}</span>
        </div>
        {source && <QuestionSourceLine source={source} mobile={mobile} className="pl-[22px]" />}
      </div>
    </div>
  );
}

export default memo(QuestionRecord) as (props: ToolViewProps) => JSX.Element | null;
