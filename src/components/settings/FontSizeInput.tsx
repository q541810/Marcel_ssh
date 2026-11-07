import { useState, useEffect, useRef } from 'react';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  clampTerminalFontSize,
} from '@/lib/terminalFont';

export function FontSizeInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [showSlider, setShowSlider] = useState(false);
  const [inputValue, setInputValue] = useState(String(value));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputValue(String(value));
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSlider(false);
      }
    }
    if (showSlider) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSlider]);

  const handleBlur = () => {
    const num = parseInt(inputValue, 10);
    const clamped = clampTerminalFontSize(num || 14);
    setInputValue(String(clamped));
    if (clamped !== value) {
      onChange(clamped);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <input
        type="number"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={() => setShowSlider(true)}
        onBlur={handleBlur}
        className="w-24 rounded-lg field px-3 py-2 text-body text-fg [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {showSlider && (
        <div 
          className="absolute top-full left-1/2 -translate-x-1/2 mt-2 p-3 bg-surface-raised border border-edge rounded-xl shadow-raised z-50 w-52 animate-slide-down"
          style={{ animationDuration: '200ms' }}
        >
          <input
            type="range"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            value={value}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v !== value) {
                setInputValue(String(v));
                onChange(v);
              }
            }}
            className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
          <div className="flex justify-between text-meta text-fg-tertiary mt-1">
            <span>{TERMINAL_FONT_SIZE_MIN}</span>
            <span className="text-indigo-400 font-medium">{value}px</span>
            <span>{TERMINAL_FONT_SIZE_MAX}</span>
          </div>
        </div>
      )}
    </div>
  );
}
