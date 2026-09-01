import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
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
}

const chevron = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

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
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(-1);

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

  useEffect(() => {
    if (!open) return;
    const idx = flat.findIndex((o) => o.value === value && !o.disabled);
    setFocusIdx(idx >= 0 ? idx : 0);
  }, [open, flat, value]);

  useEffect(() => {
    if (!open || !listRef.current || focusIdx < 0) return;
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
        setFocusIdx((prev) => {
          const next = prev + 1;
          return next < flat.length ? next : prev;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
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
        onPointerEnter={() => setFocusIdx(flatIdx)}
        className={`
          flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors
          ${active ? 'bg-zinc-700' : ''}
          ${selected ? 'text-indigo-400' : 'text-zinc-200'}
          ${opt.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-zinc-700'}
        `}
      >
        {selected ? (
          <span className="flex-shrink-0 w-4">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        ) : (
          <span className="flex-shrink-0 w-4" />
        )}
        <span className="flex-1 truncate">{opt.label}</span>
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
        onClick={() => setOpen((v) => !v)}
        className={`
          w-full flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-left
          transition-colors active:scale-[0.98]
          ${disabled
            ? 'border-zinc-700 bg-zinc-800/50 text-zinc-500 cursor-not-allowed'
            : 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:border-zinc-600 focus:outline-none focus:border-indigo-500'
          }
        `}
      >
        <span className="flex-1 truncate">{selectedLabel}</span>
        <span className={`flex-shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>
          {chevron}
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={`
            absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-auto
            rounded-lg border border-zinc-700 bg-zinc-800 shadow-2xl
          `}
          style={{ top: '100%' }}
        >
          {options.map((entry, groupIdx) => {
            if ('options' in entry) {
              // 分组：标题 + 组内选项
              const group = entry as SelectGroup<T>;
              return (
                <div key={`g-${groupIdx}`}>
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
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
