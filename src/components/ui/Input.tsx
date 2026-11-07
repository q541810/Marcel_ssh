import type { InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export default function Input({ label, error, className = '', ...props }: Props) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-meta font-medium text-fg-secondary mb-1">
          {label}
        </label>
      )}
      <input
        className={`
          w-full h-7 rounded-lg bg-surface-raised border px-3 text-body text-fg
          placeholder:text-fg-tertiary focus:outline-none transition-colors duration-120
          ${
            error
              ? 'border-red-500 focus:border-red-400'
              : 'border-edge-subtle focus:border-indigo-500'
          }
          disabled:text-fg-disabled disabled:cursor-not-allowed
          ${className}
        `}
        {...props}
      />
      {error && <p className="mt-1 text-meta text-red-400">{error}</p>}
    </div>
  );
}
