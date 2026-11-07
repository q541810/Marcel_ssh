import { useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ReasonVar } from '@/lib/types';

const fieldClass =
  'w-full resize-y rounded-lg field text-fg';

/**
 * 「拒绝说明」输入框：档位是「直接拒绝」时才出现（别的档位没有要回给模型的话）。
 * 内置规则与自定义规则共用，桌面与手机同一个组件。
 *
 * 框里**预填的是这条规则现在会回给 Agent 的默认原话**（后端规则表里的模板），用户在它的基础上改，
 * 不是对着空白框重写。原话里随命中而变的部分（命中的命令、路径……）写成 `{命令}` 这样的占位，
 * 命中时才换成实际值；框下面列出这条规则能用的占位，点一下插到光标处。
 *
 * 存储口径：和默认原话一字不差、或清空 = 不存（`onChange('')`，回到默认）；否则存用户写的整段。
 * 长度不设限，写多长占多少上下文由用户自己把握。
 */
export function DenyMessageField({
  stored,
  template,
  vars,
  onChange,
  ariaLabel,
  compact,
}: {
  /** 已存的说明；空 = 用默认。 */
  stored: string;
  /** 默认原话（带占位）。目录还没加载出来时为空。 */
  template: string;
  /** 这条规则能用的占位。 */
  vars: ReasonVar[];
  onChange: (next: string) => void;
  /** 这个输入框管哪条规则（读屏用）。 */
  ariaLabel: string;
  /** 手机。 */
  compact?: boolean;
}) {
  // 输入框里的文字单独留一份：用户退格删光时，不能因为「空 = 默认」就立刻把默认原话填回来。
  const [draft, setDraft] = useState(stored.trim() === '' ? template : stored);
  const area = useRef<HTMLTextAreaElement>(null);
  const modified = stored.trim() !== '';

  // 高度跟着内容走：默认原话有的一两行、有的好几行，固定行数要么留白要么要在框里滚。
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft]);

  const emit = (text: string) => {
    setDraft(text);
    onChange(text.trim() === '' || text === template ? '' : text);
  };

  const insert = (name: string) => {
    const el = area.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    emit(draft.slice(0, start) + token + draft.slice(end));
    // 受控输入换了值之后光标会跳到末尾，放回刚插入的占位后面。
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const chip = `inline-flex items-center rounded-md border border-edge bg-surface-raised px-2 font-mono text-fg-secondary transition-colors hover:border-indigo-500/60 hover:text-fg active:text-fg ${
    compact ? 'min-h-9 text-body' : 'min-h-7 text-meta'
  }`;

  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="text-meta text-fg-tertiary">
          拒绝说明：命中时回给 Agent 的话，可以直接改
        </span>
        <textarea
          ref={area}
          value={draft}
          onChange={(e) => emit(e.target.value)}
          rows={3}
          aria-label={ariaLabel}
          placeholder={template || '写给 Agent 的话：为什么被拒、该怎么做'}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={`${fieldClass} ${compact ? 'px-3 py-3 text-body' : 'px-3 py-2 text-body'}`}
        />
      </label>
      {(vars.length > 0 || modified) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {vars.length > 0 && (
            <>
              <span className="text-meta text-fg-tertiary">插入</span>
              {vars.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => insert(v.name)}
                  title={`${v.hint}（命中时换成实际值）`}
                  className={chip}
                >
                  {`{${v.name}}`}
                </button>
              ))}
            </>
          )}
          {modified && (
            <button
              type="button"
              onClick={() => {
                setDraft(template);
                onChange('');
              }}
              className={`ml-auto inline-flex items-center gap-1 rounded-md px-2 text-fg-secondary transition-colors hover:text-fg active:text-fg ${
                compact ? 'min-h-9 text-body' : 'min-h-7 text-meta'
              }`}
            >
              <RotateCcw className="h-3 w-3" />
              恢复默认
            </button>
          )}
        </div>
      )}
      {vars.length > 0 && (
        <p className="text-meta leading-relaxed text-fg-tertiary">
          {vars.map((v) => `{${v.name}} ${v.hint}`).join('；')}。命中时换成实际内容。
        </p>
      )}
    </div>
  );
}
