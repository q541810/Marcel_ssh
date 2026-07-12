import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

interface Props<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const chevron = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

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

  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected?.label ?? placeholder ?? value;

  const close = useCallback(() => {
    setOpen(false);
    setFocusIdx(-1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value && !o.disabled);
    setFocusIdx(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  useEffect(() => {
    if (!open || !listRef.current || focusIdx < 0) return;
    const el = listRef.current.children[focusIdx] as HTMLElement | undefined;
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
          return next < options.length ? next : prev;
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
        if (focusIdx >= 0 && focusIdx < options.length) {
          select(options[focusIdx]);
        }
        break;
    }
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
          transition-colors
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
          {options.map((opt, i) => {
            const active = i === focusIdx;
            const selected = opt.value === value;
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={selected}
                aria-disabled={opt.disabled}
                onPointerDown={(e) => {
                  e.preventDefault();
                  select(opt);
                }}
                onPointerEnter={() => setFocusIdx(i)}
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
          })}
        </div>
      )}
    </div>
  );
}
