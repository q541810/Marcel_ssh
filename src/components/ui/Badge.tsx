import type { ReactNode } from 'react';
import type { Disposition } from '@/lib/types';
import { DISPOSITION_COLORS } from '@/lib/constants';

type BadgeSize = 'sm' | 'md' | 'lg';

interface Props {
  variant?: Disposition | 'default';
  size?: BadgeSize;
  children: ReactNode;
}

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-caption',
  md: 'px-2 py-0.5 text-meta',
  lg: 'px-2 py-1 text-body',
};

const defaultStyle = 'bg-state-mid text-fg-secondary';

export default function Badge({ variant = 'default', size = 'sm', children }: Props) {
  const colorClass =
    variant === 'default' ? defaultStyle : DISPOSITION_COLORS[variant];

  return (
    <span
      className={`
        inline-flex items-center rounded-sm font-medium leading-none whitespace-nowrap
        ${colorClass}
        ${sizeStyles[size]}
      `}
    >
      {children}
    </span>
  );
}
