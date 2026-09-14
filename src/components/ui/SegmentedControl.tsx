import { useRef } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** 悬停提示：选项本身很短（两三个字）时用它补一句说明。 */
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 无障碍名（分段控件本身没有可见 label 时必填）。 */
  ariaLabel: string;
}

/**
 * 分段控件（互斥单选，2–4 项）。
 *
 * 与 Toggle 同一套观感：按下即反馈（`active:scale-95`）、`--spring-bounce`
 * 时间函数、indigo 选中态、`focus:ring` 键盘焦点环。
 *
 * 语义用 radiogroup/radio：读屏会播报「已选中/未选中」而不是「按钮」，
 * 左右方向键可在选项间移动（方向键移动 + 立即选中，和原生 radio 一致），
 * 避免用户只能靠 Tab 一个个试。
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (index: number, delta: number) => {
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex gap-0.5 rounded-lg border border-zinc-700 bg-zinc-800/60 p-0.5"
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={option.title}
            onClick={() => !disabled && onChange(option.value)}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(index, 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(index, -1);
              }
            }}
            className={`rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-100
              focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 focus:ring-offset-zinc-900
              active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed
              ${
                active
                  ? 'bg-indigo-600 text-white'
                  : 'text-zinc-300 hover:bg-zinc-700/70 hover:text-zinc-100'
              }`}
            style={{ transitionTimingFunction: 'var(--spring-bounce)' }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
