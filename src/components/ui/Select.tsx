import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import WinIcon from '@/components/ui/WinIcon';

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

const chevron = <WinIcon glyph="chevronDown" size={16} />;

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
        className={`win-input flex items-center gap-2 text-left ${disabled ? 'opacity-45 pointer-events-none' : ''}`}
      >
        <span className="flex-1 truncate">{selectedLabel}</span>
        <span className={`chevron-animate flex-shrink-0 text-zinc-500 ${open ? 'pressing' : ''}`}>
          {chevron}
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="win-flyout win-flyout-enter absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-auto py-1"
          style={{ top: '100%' }}
        >
          {options.map((opt, i) => {
            const active = i === focusIdx;
            const selectedOpt = opt.value === value;
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={selectedOpt}
                aria-disabled={opt.disabled}
                onPointerDown={(e) => {
                  e.preventDefault();
                  select(opt);
                }}
                onPointerEnter={() => setFocusIdx(i)}
                className={`win-menu-item ${active ? 'win-menu-item--active' : ''} ${opt.disabled ? 'opacity-45' : ''}`}
              >
                <span className="flex-1 truncate">{opt.label}</span>
                {selectedOpt && (
                  <WinIcon glyph="checkMark" size={16} className="flex-shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
