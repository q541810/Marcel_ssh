import type { ReactNode } from 'react';

interface MobileSettingRowProps {
  label: string;
  description?: string;
  /** Control rendered at the right of the header line (toggle, value, etc.). */
  trailing?: ReactNode;
  /** Full-width content below the header line (inputs, grids, sliders). */
  children?: ReactNode;
}

/** Touch-first settings row card: full-width, stacked, no fixed desktop widths. */
export function MobileSettingRow({
  label,
  description,
  trailing,
  children,
}: MobileSettingRowProps) {
  return (
    <div className="min-h-12 rounded-xl bg-surface-raised px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-fg">{label}</div>
          {description && (
            <div className="mt-0.5 text-meta leading-relaxed text-fg-tertiary">
              {description}
            </div>
          )}
        </div>
        {trailing != null && <div className="flex-shrink-0">{trailing}</div>}
      </div>
      {children}
    </div>
  );
}
