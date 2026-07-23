import { Check, ClipboardPaste, Copy, CornerDownLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AuxKeyId } from './terminalInput';

interface AuxKeyDef {
  id: AuxKeyId;
  label: ReactNode;
  /** Wider key (col-span-2 of the 10-col grid). */
  wide?: boolean;
}

/**
 * Two fixed rows, exactly 10 columns each — every key always visible, nothing
 * scrolls or wraps. Laid out like a physical keyboard: Esc top-left, Ctrl
 * bottom-left, and an inverted-T arrow cluster on the right (↑ sits directly
 * above ↓).
 */
const ROW1: AuxKeyDef[] = [
  { id: 'esc', label: 'Esc', wide: true },
  { id: 'tab', label: 'Tab', wide: true },
  { id: 'ctrl-c', label: '^C', wide: true },
  { id: 'ctrl-d', label: '^D' },
  { id: 'copy', label: <Copy className="mx-auto h-4 w-4" /> },
  { id: 'up', label: '↑' },
  { id: 'paste', label: <ClipboardPaste className="mx-auto h-4 w-4" /> },
];

const ROW2: AuxKeyDef[] = [
  { id: 'ctrl', label: 'Ctrl', wide: true },
  { id: 'slash', label: '/' },
  { id: 'dash', label: '-' },
  { id: 'pipe', label: '|' },
  {
    id: 'enter',
    label: <CornerDownLeft className="mx-auto h-4 w-4" />,
    wide: true,
  },
  { id: 'left', label: '←' },
  { id: 'down', label: '↓' },
  { id: 'right', label: '→' },
];

interface MobileAuxKeyBarProps {
  ctrlActive: boolean;
  /** Terminal has a non-empty selection — enables the copy key. */
  copyEnabled: boolean;
  /** Transient "copied" feedback after a successful copy. */
  copied: boolean;
  onKey: (key: AuxKeyId) => void;
}

export default function MobileAuxKeyBar({
  ctrlActive,
  copyEnabled,
  copied,
  onKey,
}: MobileAuxKeyBarProps) {
  const renderRow = (row: AuxKeyDef[]) => (
    <div className="grid grid-cols-10 gap-1">
      {row.map((key) => {
        const active = key.id === 'ctrl' && ctrlActive;
        const isCopy = key.id === 'copy';
        const disabled = isCopy && !copyEnabled && !copied;
        const label =
          isCopy && copied ? <Check className="mx-auto h-4 w-4" /> : key.label;
        const colorClass = active
          ? 'border-green-500 bg-green-500/20 text-green-300'
          : isCopy && copied
            ? 'border-emerald-600 bg-emerald-500/20 text-emerald-300'
            : 'border-zinc-700/80 bg-zinc-800 text-zinc-200 active:bg-zinc-700';
        return (
          <button
            key={key.id}
            type="button"
            disabled={disabled}
            // Keep soft keyboard open: don't steal focus from xterm textarea.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onKey(key.id)}
            aria-label={isCopy ? (copied ? '已复制' : '复制选中内容') : undefined}
            className={`rounded-md border py-2 text-center text-xs font-medium transition-colors duration-100 active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${
              key.wide ? 'col-span-2' : 'col-span-1'
            } ${colorClass}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      className="flex flex-shrink-0 flex-col gap-1 border-t border-zinc-800 bg-zinc-900 px-1.5 py-1.5"
      style={{
        // When the IME is open the content area already sits above the
        // keyboard, so subtract --ime-bottom from the nav-bar safe-area to
        // avoid a double gap. When the keyboard is closed --ime-bottom is 0
        // and this collapses to the normal safe-area pad.
        paddingBottom:
          'max(0.375rem, calc(env(safe-area-inset-bottom, 0px) - var(--ime-bottom, 0px)))',
      }}
    >
      {renderRow(ROW1)}
      {renderRow(ROW2)}
    </div>
  );
}
