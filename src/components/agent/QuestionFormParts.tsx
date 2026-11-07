import { Check } from 'lucide-react';
import type { QuestionForm } from './useQuestionForm';

/**
 * 题干 + 选项 + 自由输入框（桌面浮层面板与内联卡片共用的正文）。
 * `compact`：收尾提问的紧凑卡片用——题干更醒目、选项与输入框更矮。
 */
export function QuestionFormBody({ form, compact = false }: { form: QuestionForm; compact?: boolean }) {
  const { current, currentAnswer, toggleOption, setCustom, next } = form;
  if (!current) return null;
  const hasOptions = !!current.options?.length;
  return (
    <>
      <p className={`text-read leading-relaxed ${compact ? 'text-fg' : 'text-fg'}`}>{current.question}</p>

      {hasOptions && (
        <div className="space-y-1.5">
          {current.options!.map((opt) => {
            const isSelected = current.multiple
              ? currentAnswer.selected.includes(opt.label)
              : currentAnswer.custom === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => toggleOption(opt.label)}
                className={`w-full text-left px-3 ${compact ? 'py-1.5' : 'py-2'} rounded-lg border transition-colors ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-600/15 text-indigo-200'
                    : 'border-edge bg-surface-raised/50 text-fg hover:border-edge-strong hover:bg-state-mid/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  {current.multiple ? (
                    <div
                      className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                        isSelected ? 'border-indigo-500 bg-indigo-600' : 'border-edge-strong'
                      }`}
                    >
                      {isSelected && (
                        <Check className="w-3 h-3 text-white" strokeWidth={1.5} />
                      )}
                    </div>
                  ) : (
                    <div
                      className={`w-4 h-4 rounded-full border flex-shrink-0 flex items-center justify-center transition-colors ${
                        isSelected ? 'border-indigo-500 bg-indigo-600' : 'border-edge-strong'
                      }`}
                    >
                      {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                  )}
                  <span className="text-read font-medium">{opt.label}</span>
                </div>
                {opt.description && (
                  <p className="text-meta text-fg-tertiary mt-0.5 ml-6">{opt.description}</p>
                )}
              </button>
            );
          })}
        </div>
      )}

      <textarea
        ref={form.inputRef}
        rows={compact ? 1 : 2}
        value={currentAnswer.custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            next();
          }
        }}
        placeholder={
          current.multiple ? '补充说明（可选）...' : hasOptions ? '或输入自定义回答...' : '输入你的回答...'
        }
        className="w-full px-3 py-2 rounded-lg bg-surface border border-edge text-read text-fg placeholder:text-fg-tertiary outline-none focus:border-indigo-500 resize-none leading-relaxed"
      />
    </>
  );
}

/** 上一题 / 下一题 / 提交（桌面浮层面板与内联卡片共用）。`compact`：不带分隔线与自己的内边距。 */
export function QuestionFormFooter({ form, compact = false }: { form: QuestionForm; compact?: boolean }) {
  const { isFirst, isLast, prev, next } = form;
  return (
    <div className={`flex items-center justify-between ${compact ? '' : 'px-4 py-3 border-t border-edge'}`}>
      <div className="text-meta text-fg-tertiary">
        <kbd className="px-1 py-0.5 rounded bg-state-mid text-fg-secondary">Enter</kbd>{' '}
        {isLast ? '提交' : '下一题'}
      </div>
      <div className="flex items-center gap-2">
        {!isFirst && (
          <button
            type="button"
            onClick={prev}
            className="px-3 py-1.5 rounded-lg text-read text-fg-secondary hover:text-fg hover:bg-state-mid transition-colors"
          >
            ← 上一题
          </button>
        )}
        <button
          type="button"
          onClick={next}
          className="px-4 py-1.5 rounded-lg text-read font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
        >
          {isLast ? '提交答案' : '下一题 →'}
        </button>
      </div>
    </div>
  );
}
