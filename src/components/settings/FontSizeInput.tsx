import { useState, useEffect, useRef } from 'react';

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
    const clamped = Math.max(10, Math.min(32, num || 14));
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
        className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {showSlider && (
        <div 
          className="absolute top-full left-1/2 -translate-x-1/2 mt-2 p-3 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-50 w-52 animate-slide-down"
          style={{ animationDuration: '200ms', animationTimingFunction: 'var(--spring-bounce)' }}
        >
          <input
            type="range"
            min={10}
            max={32}
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
          <div className="flex justify-between text-xs text-zinc-500 mt-1">
            <span>10</span>
            <span className="text-indigo-400 font-medium">{value}px</span>
            <span>32</span>
          </div>
        </div>
      )}
    </div>
  );
}
