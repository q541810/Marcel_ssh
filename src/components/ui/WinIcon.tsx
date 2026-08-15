import type { CSSProperties } from 'react';
import { SEGOE_GLYPHS, type SegoeGlyph } from '@/lib/icons';

interface Props {
  glyph: SegoeGlyph;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** Renders a Segoe Fluent Icon glyph (WinUI iconography). */
export default function WinIcon({ glyph, size = 16, className = '', style }: Props) {
  return (
    <span
      aria-hidden="true"
      className={`win-icon ${className}`}
      style={{ fontSize: size, lineHeight: 1, ...style }}
    >
      {SEGOE_GLYPHS[glyph]}
    </span>
  );
}
