import type { InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export default function Input({ label, error, className = '', ...props }: Props) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-meta font-medium text-fg-secondary mb-1.5">
          {label}
        </label>
      )}
      <input
        aria-invalid={error ? true : undefined}
        className={`field w-full h-9 rounded-lg px-3 text-body text-fg ${className}`}
        {...props}
      />
      {error && <p className="mt-1.5 text-meta text-red-400">{error}</p>}
    </div>
  );
}
