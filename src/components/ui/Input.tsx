import type { InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export default function Input({ label, error, className = '', ...props }: Props) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-zinc-300 mb-1">
          {label}
        </label>
      )}
      <input
        className={`
          w-full rounded-lg bg-zinc-800 border px-3 py-2 text-sm text-zinc-100
          placeholder:text-zinc-500 focus:outline-none transition-colors
          ${
            error
              ? 'border-red-500 focus:border-red-400'
              : 'border-zinc-700 focus:border-green-500'
          }
          disabled:opacity-50 disabled:cursor-not-allowed
          ${className}
        `}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
