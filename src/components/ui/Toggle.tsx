type ToggleSize = 'sm' | 'md';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  /** 屏幕阅读器用的名字；界面上已有可见标题、不想再排一遍文字时用它。 */
  ariaLabel?: string;
  size?: ToggleSize;
}

const sizeStyles: Record<ToggleSize, { track: string; knob: string; checkedLeft: string; uncheckedLeft: string }> = {
  sm: {
    track: 'h-4 w-7',
    knob: 'h-3 w-3',
    checkedLeft: 'left-3.5',
    uncheckedLeft: 'left-0.5',
  },
  md: {
    track: 'h-6 w-11',
    knob: 'h-5 w-5',
    checkedLeft: 'left-[1.375rem]',
    uncheckedLeft: 'left-0.5',
  },
};

export default function Toggle({ checked, onChange, disabled = false, label, ariaLabel, size = 'md' }: ToggleProps) {
  const s = sizeStyles[size];
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!disabled) onChange(!checked);
          }
        }}
        className={`
          relative inline-flex ${s.track} flex-shrink-0 items-center rounded-full
          pressable focus-ring
          disabled:opacity-50 disabled:cursor-not-allowed
          ${checked ? 'bg-indigo-600' : 'bg-fill-strong'}
        `}
      >
        <span
          className={`
            pointer-events-none absolute inline-block ${s.knob} rounded-full
            bg-white shadow-raised ring-0
            ${checked ? s.checkedLeft : s.uncheckedLeft} transition-[left] duration-200 ease-standard
          `}
        />
      </button>
      {label && (
        <span className="text-body text-fg-secondary">{label}</span>
      )}
    </label>
  );
}
