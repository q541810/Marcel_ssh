import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** 选项下方的一行小字（只在展开的列表里显示，触发按钮里不带）。用来补一句"选了会怎样"。 */
  hint?: ReactNode;
  disabled?: boolean;
}

/** 分组选项：`{ label, options }`。扁平选项直接是 SelectOption[]。 */
export interface SelectGroup<T extends string = string> {
  label: ReactNode;
  options: SelectOption<T>[];
}

/** 扁平选项或分组选项的混合数组（同一列表可混用，如「跟随默认」+ 分组）。 */
export type SelectSource<T extends string = string> = (SelectOption<T> | SelectGroup<T>)[];

interface Props<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectSource<T>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** 触发按钮的无障碍名称。选项没有可见的字段标签时（行内下拉）必须给，否则读屏只会读当前值。 */
  ariaLabel?: string;
  /**
   * 展开列表的横向定位/宽度类名，缺省与触发按钮等宽。选项带 `hint` 时按钮往往很窄，
   * 列表需要比它宽（例如 `left-auto right-0 w-60`）。
   */
  menuClassName?: string;
}

const chevron = <ChevronDown size={16} strokeWidth={1.5} />;

/** 把扁平/分组选项统一展平，用于「当前值对应的选项」查找与键盘导航。 */
function flattenOptions<T extends string>(options: SelectSource<T>): SelectOption<T>[] {
  return options.flatMap((o) => ('options' in o ? o.options : [o]));
}

export default function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = '',
  ariaLabel,
  menuClassName = 'left-0 right-0',
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const presence = useAnimatedPresence(open);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(-1);
  /** 只有键盘导航 / 刚打开时才把高亮项滚进视野；鼠标悬停改变高亮不该滚动列表。 */
  const scrollToFocus = useRef(false);

  const flat = flattenOptions(options);
  const flatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flat.forEach((o, i) => {
      if (!map.has(o.value)) map.set(o.value, i);
    });
    return map;
  }, [flat]);
  const selected = flat.find((o) => o.value === value);
  const selectedLabel = selected?.label ?? placeholder ?? value;

  const close = useCallback(() => {
    setOpen(false);
    setFocusIdx(-1);
  }, []);

  // 只在「打开」那一刻把高亮放到当前值上。不能依赖 flat / value：flat 每次渲染都是新数组，
  // 悬停改 focusIdx 触发重渲染，这个 effect 就会把高亮和滚动位置又拉回当前值——
  // 用滚轮滑长列表时表现为「滑几下就被弹回去」。
  const latest = useRef({ flat, value });
  latest.current = { flat, value };
  useEffect(() => {
    if (!open) return;
    const { flat: items, value: current } = latest.current;
    const idx = items.findIndex((o) => o.value === current && !o.disabled);
    scrollToFocus.current = true;
    setFocusIdx(idx >= 0 ? idx : 0);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current || focusIdx < 0 || !scrollToFocus.current) return;
    const children = listRef.current.querySelectorAll('[data-opt]');
    const el = children[focusIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx, open]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close();
    };
    if (open) document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const select = useCallback(
    (opt: SelectOption<T>) => {
      if (opt.disabled) return;
      onChange(opt.value);
      close();
    },
    [onChange, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        scrollToFocus.current = true;
        setFocusIdx((prev) => {
          const next = prev + 1;
          return next < flat.length ? next : prev;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        scrollToFocus.current = true;
        setFocusIdx((prev) => {
          const next = prev - 1;
          return next >= 0 ? next : prev;
        });
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusIdx >= 0 && focusIdx < flat.length) {
          select(flat[focusIdx]);
        }
        break;
    }
  };

  /** 渲染一个扁平选项行（键盘索引由调用方统一维护）。 */
  const renderOption = (opt: SelectOption<T>, flatIdx: number) => {
    const active = flatIdx === focusIdx;
    const selected = opt.value === value;
    return (
      <div
        key={opt.value}
        data-opt
        role="option"
        aria-selected={selected}
        aria-disabled={opt.disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          select(opt);
        }}
        onPointerEnter={() => {
          scrollToFocus.current = false;
          setFocusIdx(flatIdx);
        }}
        className={`
          flex items-center gap-2 px-3 py-1.5 min-h-7 text-body rounded-md cursor-pointer transition-colors duration-120
          ${active ? 'bg-state-soft' : ''}
          ${selected ? 'text-indigo-400' : 'text-fg'}
          ${opt.disabled ? 'text-fg-disabled cursor-not-allowed' : 'hover:bg-state-soft'}
        `}
      >
        {selected ? (
          <span className="flex-shrink-0 w-4">
            <Check size={14} strokeWidth={1.5} />
          </span>
        ) : (
          <span className="flex-shrink-0 w-4" />
        )}
        {opt.hint ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate">{opt.label}</span>
            <span className="block truncate text-meta text-fg-tertiary">{opt.hint}</span>
          </span>
        ) : (
          <span className="flex-1 truncate">{opt.label}</span>
        )}
      </div>
    );
  };

  return (
    <div ref={containerRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={`
          pressable focus-ring w-full h-7 flex items-center gap-2 rounded-lg border px-3 text-body text-left
          ${disabled
            ? 'border-edge-subtle bg-field text-fg-disabled cursor-not-allowed'
            : 'border-edge-strong bg-field text-fg hover:border-fg-tertiary focus:border-indigo-500'
          }
        `}
      >
        <span className="flex-1 truncate">{selectedLabel}</span>
        <span className={`flex-shrink-0 text-fg-tertiary transition-transform duration-120 ease-standard ${open ? 'rotate-180' : ''}`}>
          {chevron}
        </span>
      </button>

      {presence.mounted && (
        <div
          ref={listRef}
          role="listbox"
          onAnimationEnd={presence.onAnimationEnd}
          className={`
            absolute z-50 ${menuClassName} mt-1 max-h-60 overflow-auto
            rounded-xl surface-glass p-1
            ${presence.phase === 'exit' ? 'dropdown-exit pointer-events-none' : 'dropdown-enter'}
          `}
          style={{ top: '100%' }}
        >
          {options.map((entry, groupIdx) => {
            if ('options' in entry) {
              // 分组：标题 + 组内选项
              const group = entry as SelectGroup<T>;
              return (
                <div key={`g-${groupIdx}`}>
                  <div className="px-3 pt-2 pb-1 text-caption font-medium uppercase tracking-wide text-fg-tertiary">
                    {group.label}
                  </div>
                  {group.options.map((opt) => {
                    const idx = flatIndex.get(opt.value) ?? 0;
                    return renderOption(opt, idx);
                  })}
                </div>
              );
            }
            // 扁平：普通选项
            const opt = entry as SelectOption<T>;
            const flatIdx = flatIndex.get(opt.value) ?? groupIdx;
            return renderOption(opt, flatIdx);
          })}
        </div>
      )}
    </div>
  );
}
