interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export default function Toggle({ checked, onChange, disabled = false, label }: ToggleProps) {
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
          relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full
          transition-colors duration-300
          focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900
          disabled:opacity-50 disabled:cursor-not-allowed
          active:scale-95
          ${checked ? 'bg-indigo-600' : 'bg-zinc-700'}
        `}
        style={{ transitionTimingFunction: 'var(--spring-bounce)' }}
      >
        <span
          className={`
            pointer-events-none absolute left-0.5 inline-block h-5 w-5 rounded-full
            bg-white shadow ring-0
            ${checked ? 'animate-toggle-on' : 'animate-toggle-off'}
          `}
          style={{ animationDuration: '400ms', animationTimingFunction: 'var(--spring-bounce)' }}
        />
      </button>
      {label && (
        <span className="text-sm text-zinc-300">{label}</span>
      )}
    </label>
  );
}
