import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { QuestionItem, QuestionAnswer, SubagentQuestionSource } from '@/lib/types';
import { useQuestionForm } from './useQuestionForm';
import { QuestionFormBody, QuestionFormFooter } from './QuestionFormParts';
import { QuestionSourceLine } from './QuestionSourceLine';

interface Props {
  questionId: string;
  questions: QuestionItem[];
  onSubmit: (questionId: string, answers: QuestionAnswer[]) => void;
  onCancel: () => void;
  sessionName?: string;
  conversationTitle?: string;
  isCurrentContext?: boolean;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
  queueLength?: number;
  onMinimize?: (e?: React.MouseEvent) => void;
  /** 主 agent 转述子 agent 的提问时带上来源。 */
  source?: SubagentQuestionSource;
}

export default function QuestionPanel({
  questionId,
  questions,
  onSubmit,
  onCancel,
  sessionName,
  conversationTitle,
  isCurrentContext = true,
  onNavigateToContext,
  queueLength = 1,
  onMinimize,
  source,
}: Props) {
  const form = useQuestionForm({ questionId, questions, onSubmit });
  const { current, index, total } = form;

  // 畸形载荷（0 题）：不渲染，也不崩（放在所有 hook 之后，hooks 顺序不能依赖载荷形状）
  if (!current) return null;

  return (
    <div className="p-3">
      <div className="rounded-xl bg-surface-raised border border-indigo-500/30 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-2 min-w-0">
            <svg
              className="w-4 h-4 flex-shrink-0 text-indigo-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <span className="text-read font-semibold text-fg truncate">
              {current.header}
            </span>
            {current.multiple && (
              <span className="flex-shrink-0 text-meta px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-300">
                可多选
              </span>
            )}
            {queueLength > 1 && (
              <span className="text-caption px-2 py-0.5 rounded-full bg-indigo-900/60 border border-indigo-700/50 text-indigo-300 font-medium">
                队列 1/{queueLength}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-meta text-fg-tertiary">
              {index + 1}/{total}
            </span>
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className="p-1 rounded text-fg-secondary hover:text-fg hover:bg-state-mid transition-colors"
                title="最小化为浮动药丸"
                aria-label="最小化"
              >
                <ChevronDown className="w-4 h-4" strokeWidth={1.5} />
              </button>
            )}
            <button
              onClick={form.skip}
              className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-mid transition-colors"
              title="取消"
            >
              <X className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {source && <QuestionSourceLine source={source} className="mx-4 mt-3" />}

        {/* 上下文横条提示 (Context Banner) */}
        {(sessionName || conversationTitle) && (
          <div className="mx-4 mt-3 p-2 rounded-lg bg-surface border border-edge/70 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-3.5 h-3.5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-meta text-fg-secondary truncate">
                <span className="font-semibold text-fg">{sessionName || 'SSH 会话'}</span>
                {conversationTitle && (
                  <span className="text-fg-secondary"> · {conversationTitle}</span>
                )}
              </div>
            </div>
            {onNavigateToContext && (
              <button
                type="button"
                onClick={onNavigateToContext}
                className="shrink-0 text-caption px-2 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 transition-colors font-medium flex items-center gap-1 pressable"
              >
                <span>跳转查看</span>
                <ChevronRight className="w-2.5 h-2.5" strokeWidth={1.5} />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-4 py-3 space-y-3 max-h-[40vh] overflow-y-auto">
          <QuestionFormBody form={form} />
        </div>

        <QuestionFormFooter form={form} />
      </div>
    </div>
  );
}
