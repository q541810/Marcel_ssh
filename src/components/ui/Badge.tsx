import type { ReactNode } from 'react';
import type { RiskLevel } from '@/lib/types';
import { RISK_LEVEL_COLORS } from '@/lib/constants';

type BadgeSize = 'sm' | 'md' | 'lg';

interface Props {
  variant?: RiskLevel | 'default';
  size?: BadgeSize;
  children: ReactNode;
}

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
  lg: 'px-2.5 py-1 text-sm',
};

const defaultStyle = 'bg-zinc-700 text-zinc-300';

export default function Badge({ variant = 'default', size = 'sm', children }: Props) {
  const colorClass =
    variant === 'default' ? defaultStyle : RISK_LEVEL_COLORS[variant];

  return (
    <span
      className={`
        inline-flex items-center rounded font-medium leading-none whitespace-nowrap
        ${colorClass}
        ${sizeStyles[size]}
      `}
    >
      {children}
    </span>
  );
}
