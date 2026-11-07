import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

const disabledBase = 'disabled:bg-state-soft disabled:text-fg-disabled disabled:border-transparent';

const variantStyles: Record<ButtonVariant, string> = {
  primary: `bg-indigo-600 text-white hover:bg-indigo-500 ${disabledBase}`,
  secondary: `bg-surface-raised text-fg border border-edge-subtle hover:bg-state-mid disabled:bg-surface-raised disabled:text-fg-disabled`,
  danger: `bg-red-600 text-white hover:bg-red-500 ${disabledBase}`,
  ghost:
    'bg-transparent text-fg-secondary hover:bg-state-soft hover:text-fg disabled:bg-transparent disabled:text-fg-disabled',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-meta',
  md: 'h-7 px-3 text-body',
  lg: 'h-8 px-4 text-body',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...props
}: Props) {
  return (
    <button
      disabled={disabled || loading}
      className={`
        pressable focus-ring inline-flex items-center justify-center gap-2 rounded-lg font-medium
        disabled:cursor-not-allowed
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${className}
      `}
      {...props}
    >
      {loading && (
        <svg
          className="animate-spin h-4 w-4"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {children}
    </button>
  );
}
