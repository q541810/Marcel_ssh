import { useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import MobileSheet from './MobileSheet';

export interface MobileSelectOption<T extends string> {
  value: T;
  /** 触发按钮上显示的文字，也是面板里这一行的主文字。 */
  label: string;
  /** 面板里主文字下面的小字（"选了会怎样"之类）。 */
  hint?: string;
  /** 主文字右边的小标签（例如「默认」）。 */
  badge?: string;
  /** 主文字左边的装饰（例如档位色点），已含自己的尺寸与颜色。 */
  leading?: ReactNode;
  disabled?: boolean;
}

interface MobileSelectProps<T extends string> {
  value: T;
  options: readonly MobileSelectOption<T>[];
  onChange: (value: T) => void;
  /** 读屏名（例如「认证方式」）；触发按钮会自动补上「当前……」。 */
  ariaLabel: string;
  /** 面板标题；缺省用 ariaLabel。 */
  title?: string;
  /** value 不在 options 里时触发按钮显示的文字（例如「选择连接…」）。 */
  placeholder?: string;
  disabled?: boolean;
  /** 触发按钮的外观（宽度、边框、底色、文字色），让它能和同一表单里的输入框长得一样。 */
  className?: string;
}

const DEFAULT_TRIGGER_CLASS =
  'w-full rounded-lg field px-3 py-2.5 text-body text-fg';

/**
 * 移动端的下拉：一个看起来像下拉的按钮，点开从底部升起选项面板（`MobileSheet`）。
 *
 * 取代原生 select 元素：Android 会为它弹出系统自带的白底大字对话框，深色主题下刺眼、不跟应用主题走，
 * 也放不下选项的说明。整个移动端的"多选一下拉"都走这里，别再写原生 select。
 *
 * 语义用 radiogroup/radio（读屏播报「已选中」）；点当前项只收起，不触发 onChange。
 */
export default function MobileSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  placeholder,
  disabled,
  className = DEFAULT_TRIGGER_CLASS,
}: MobileSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const shown = current?.label ?? placeholder ?? '';
  return (
    <>
      <button
        type="button"
        aria-label={current ? `${ariaLabel}（当前${current.label}）` : ariaLabel}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={`flex min-h-11 items-center justify-between gap-2 text-left outline-none focus:border-indigo-500 active:opacity-70 disabled:opacity-40 ${className}`}
      >
        <span className={`min-w-0 truncate ${current ? '' : 'text-fg-tertiary'}`}>
          {shown}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
      </button>
      <MobileSheet open={open} onClose={() => setOpen(false)} title={title ?? ariaLabel}>
        <div role="radiogroup" aria-label={ariaLabel} className="px-2 pb-3">
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={o.disabled}
                onClick={() => {
                  if (!selected) onChange(o.value);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left active:bg-state-soft disabled:opacity-40"
              >
                {o.leading}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-body text-fg">
                    <span className="min-w-0 break-words">{o.label}</span>
                    {o.badge && (
                      <span className="flex-shrink-0 rounded border border-edge px-1 py-px text-caption text-fg-secondary">
                        {o.badge}
                      </span>
                    )}
                  </span>
                  {o.hint && (
                    <span className="mt-0.5 block text-meta leading-relaxed text-fg-tertiary">
                      {o.hint}
                    </span>
                  )}
                </span>
                {selected && (
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-400" />
                )}
              </button>
            );
          })}
        </div>
      </MobileSheet>
    </>
  );
}
