import { useEffect } from 'react';
import type { QuestionItem, QuestionAnswer, SubagentQuestionSource } from '@/lib/types';
import { useQuestionForm } from '@/components/agent/useQuestionForm';
import { QuestionSourceLine } from '@/components/agent/QuestionSourceLine';
import { registerBackHandler } from './backHandler';
import { MobileQuestionBody, MobileQuestionFooter } from './MobileQuestionParts';

interface MobileQuestionPanelProps {
  questionId: string;
  questions: QuestionItem[];
  onSubmit: (questionId: string, answers: QuestionAnswer[]) => void;
  sessionName?: string;
  conversationTitle?: string;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
  queueLength?: number;
  onMinimize?: (e?: React.MouseEvent) => void;
  /** 主 agent 转述子 agent 的提问时带上来源。 */
  source?: SubagentQuestionSource;
}

/**
 * 手机提问面板：agent 停下来等答案才能继续，所以像审批一样从底部升起、无论用户此刻在看
 * 哪一页（聊天 / 终端 / 文件）。可收起成浮动胶囊、Android 返回键 = 收起（防止误退会话）、
 * 带「去那条对话」的上下文横条。
 * 状态逻辑与桌面共用 `useQuestionForm`，这里只负责触屏外观。
 */
export default function MobileQuestionPanel({
  questionId,
  questions,
  onSubmit,
  sessionName,
  conversationTitle,
  onNavigateToContext,
  queueLength = 1,
  onMinimize,
  source,
}: MobileQuestionPanelProps) {
  // 注册 Android 侧滑返回：按下返回键时最小化为浮动胶囊，防止误退会话或关闭应用
  useEffect(() => {
    return registerBackHandler(() => {
      onMinimize?.();
    });
  }, [onMinimize]);

  // 手机上不程序化 focus：会唤起软键盘，键盘只在用户点输入框时弹起
  const form = useQuestionForm({
    questionId, questions, onSubmit, focusOnQuestionChange: false, focusOnNavigate: false,
  });
  const { current, index, total } = form;
  // 畸形载荷（0 题）：不渲染，也不崩（放在所有 hook 之后）
  if (!current) return null;

  return (
    <div
      className="mobile-panel-enter flex-shrink-0 border-t border-indigo-700/40 bg-surface"
      data-region="mobile-question-panel"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        marginBottom: 'var(--ime-bottom, 0px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg">
          {current.header}
        </span>
        {current.multiple && (
          <span className="flex-shrink-0 rounded bg-indigo-600/20 px-1.5 py-0.5 text-caption text-indigo-300">
            可多选
          </span>
        )}
        {queueLength > 1 && (
          <span className="flex-shrink-0 rounded-full border border-indigo-700/50 bg-indigo-900/60 px-1.5 py-0.5 text-caption font-medium text-indigo-300">
            1/{queueLength}
          </span>
        )}
        {total > 1 && (
          <span className="flex-shrink-0 text-meta text-fg-tertiary">
            {index + 1}/{total}
          </span>
        )}
        {onMinimize && (
          <button
            type="button"
            onClick={onMinimize}
            className="flex-shrink-0 rounded-lg p-1 text-fg-secondary active:bg-state-soft"
            title="收起为浮动条"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={form.skip}
          className="-mr-2 flex-shrink-0 rounded-lg min-h-11 px-2 py-1 text-body text-fg-tertiary active:bg-state-soft"
        >
          跳过
        </button>
      </div>

      {source && <QuestionSourceLine mobile source={source} className="px-4 pb-1" />}

      {/* 上下文横条：提问来自哪台机器 / 哪条对话，并给一个去那里的入口 */}
      {(sessionName || conversationTitle) && (
        <div className="mx-4 mt-1.5 flex items-center justify-between gap-2 rounded-xl border border-edge-subtle bg-surface-sunken p-2">
          <div className="min-w-0 truncate text-meta text-fg-secondary">
            <span className="font-semibold text-fg">{sessionName || 'SSH 会话'}</span>
            {conversationTitle && <span className="text-fg-secondary"> · {conversationTitle}</span>}
          </div>
          {onNavigateToContext && (
            <button
              type="button"
              onClick={onNavigateToContext}
              className="shrink-0 rounded-lg border border-edge px-2 py-0.5 text-caption font-medium text-fg-secondary active:bg-state-soft"
            >
              跳转
            </button>
          )}
        </div>
      )}

      {/* Body */}
      <div className="max-h-[45dvh] space-y-2.5 overflow-y-auto overscroll-contain px-4 py-2">
        <MobileQuestionBody form={form} />
      </div>

      {/* Footer */}
      <MobileQuestionFooter form={form} className="px-4 pb-3 pt-1" />
    </div>
  );
}
