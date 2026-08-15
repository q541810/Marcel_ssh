type ToggleSize = 'sm' | 'md';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  size?: ToggleSize;
}

export default function Toggle({ checked, onChange, disabled = false, label, size = 'md' }: ToggleProps) {
  return (
    <label className={`flex items-center gap-2 cursor-pointer select-none ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
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
        className={`win-toggle ${checked ? 'on' : ''}`}
        style={size === 'sm' ? { transform: 'scale(0.75)', transformOrigin: 'left center' } : undefined}
      >
        <span className="win-toggle-thumb" />
      </button>
      {label && (
        <span className="text-sm text-zinc-300">{label}</span>
      )}
    </label>
  );
}
