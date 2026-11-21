import { Check, ClipboardPaste, Copy, CornerDownLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AuxKeyId } from './terminalInput';

interface AuxKeyDef {
  id: AuxKeyId;
  label: ReactNode;
  /** Width in grid columns (default 1). */
  span?: number;
  /** Smaller label — keeps 4-letter words off the key's border. */
  compact?: boolean;
}

/**
 * Two fixed rows, 12 columns each — every key always visible, nothing scrolls
 * or wraps. Laid out like a physical keyboard: Esc top-left, Ctrl bottom-left,
 * and an inverted-T arrow cluster on the right.
 *
 * Why 12 columns and not 10: at 1/10 of the row, Home was left with ~28px of
 * content box while the four letters need ~30px at 12px, so the label spilled
 * past the key's border (visible on the reviewer's screenshot). Home/End now
 * take two columns each. Row 2 has fewer keys, so Ctrl and Enter take three;
 * both rows total 12 columns and the right-hand cluster (copy/←, ↑/↓, paste/→)
 * still occupies columns 9-11, so the pairs stay vertically aligned.
 */
const ROW1: AuxKeyDef[] = [
  { id: 'esc', label: 'Esc', span: 2 },
  { id: 'tab', label: 'Tab' },
  { id: 'ctrl-c', label: '^C' },
  { id: 'ctrl-d', label: '^D' },
  { id: 'home', label: 'Home', span: 2, compact: true },
  { id: 'end', label: 'End', span: 2, compact: true },
  { id: 'copy', label: <Copy className="mx-auto h-4 w-4" /> },
  { id: 'up', label: '↑' },
  { id: 'paste', label: <ClipboardPaste className="mx-auto h-4 w-4" /> },
];

const ROW2: AuxKeyDef[] = [
  { id: 'ctrl', label: 'Ctrl', span: 3 },
  { id: 'slash', label: '/' },
  { id: 'dash', label: '-' },
  { id: 'pipe', label: '|' },
  {
    id: 'enter',
    label: <CornerDownLeft className="mx-auto h-4 w-4" />,
    span: 3,
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
    <div className="grid grid-cols-12 gap-1">
      {row.map((key) => {
        const active = key.id === 'ctrl' && ctrlActive;
        const isCopy = key.id === 'copy';
        const disabled = isCopy && !copyEnabled && !copied;
        const label =
          isCopy && copied ? <Check className="mx-auto h-4 w-4" /> : key.label;
        const colorClass = active
          ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300'
          : isCopy && copied
            ? 'border-emerald-600 bg-emerald-500/20 text-emerald-300'
            : 'border-edge/80 bg-surface-raised text-fg active:bg-state-mid';
        return (
          <button
            key={key.id}
            type="button"
            disabled={disabled}
            // Keep soft keyboard open: don't steal focus from xterm textarea.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onKey(key.id)}
            aria-label={isCopy ? (copied ? '已复制' : '复制选中内容') : undefined}
            className={`rounded-md border py-2 text-center font-medium ${key.compact ? 'text-caption' : 'text-meta'} pressable disabled:opacity-40 ${
              key.span === 3
                ? 'col-span-3'
                : key.span === 2
                  ? 'col-span-2'
                  : 'col-span-1'
            } ${colorClass}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    // 底部只留 py-1.5 的视觉留白，不再叠安全区：它下面压着的低栏已经吃过一次
    // （键盘弹起时则是键盘本体占掉）。再算一遍就成了重复扣减 —— 各机型
    // env(safe-area-inset-bottom) 报的值不同（小米有、iQOO 报 0），于是同一份
    // 代码在一台上贴着低栏、另一台凭空多一截缝。
    <div className="flex flex-shrink-0 flex-col gap-1 border-t border-edge-subtle bg-surface px-1.5 py-1.5">
      {renderRow(ROW1)}
      {renderRow(ROW2)}
    </div>
  );
}
