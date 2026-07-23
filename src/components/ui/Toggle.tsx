type ToggleSize = 'sm' | 'md';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
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
    checkedLeft: 'left-6',
    uncheckedLeft: 'left-0.5',
  },
};

export default function Toggle({ checked, onChange, disabled = false, label, size = 'md' }: ToggleProps) {
  const s = sizeStyles[size];
  const isMd = size === 'md';
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            !disabled && onChange(!checked);
          }
        }}
        className={`
          relative inline-flex ${s.track} flex-shrink-0 items-center rounded-full
          transition-colors duration-300
          focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-zinc-900
          disabled:opacity-50 disabled:cursor-not-allowed
          active:scale-95
          ${checked ? 'bg-green-600' : 'bg-zinc-700'}
        `}
        style={{ transitionTimingFunction: 'var(--spring-bounce)' }}
      >
        <span
          className={`
            pointer-events-none absolute inline-block ${s.knob} rounded-full
            bg-white shadow ring-0
            ${isMd ? 'left-0.5 ' + (checked ? 'animate-toggle-on' : 'animate-toggle-off') : (checked ? s.checkedLeft + ' transition-all duration-200' : s.uncheckedLeft + ' transition-all duration-200')}
          `}
          style={isMd ? { animationDuration: '400ms', animationTimingFunction: 'var(--spring-bounce)' } : undefined}
        />
      </button>
      {label && (
        <span className="text-sm text-zinc-300">{label}</span>
      )}
    </label>
  );
}
