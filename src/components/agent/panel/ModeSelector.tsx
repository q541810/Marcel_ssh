import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from "react";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { AGENT_MODES } from "@/lib/constants";
import type { AgentMode } from "@/lib/types";

type ModeSelectorProps = {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
};

/** 模式切换器：按钮 + 上弹 listbox（自持开关状态与点外关闭）。 */
export function ModeSelector({ mode, setMode }: ModeSelectorProps) {
  const [modeDrawerOpen, setModeDrawerOpen] = useState(false);
  const modeDrawerPresence = useAnimatedPresence(modeDrawerOpen);
  const drawerRef = useRef<HTMLDivElement>(null);
  const currentModeInfo =
    AGENT_MODES.find((m) => m.value === mode) ?? AGENT_MODES[1];

  useEffect(() => {
    if (!modeDrawerOpen) return;
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setModeDrawerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modeDrawerOpen]);

  return (
    <div className="relative min-w-0" ref={drawerRef}>
      <button
        type="button"
        onClick={() => setModeDrawerOpen((v) => !v)}
        className={`
                flex w-full min-w-0 items-center gap-1 px-2 py-1.5 text-meta font-medium transition-colors rounded-full
                ${
                  modeDrawerOpen
                    ? "bg-state-mid text-fg"
                    : "text-fg-secondary hover:text-fg hover:bg-state-mid/50"
                }
              `}
        title={currentModeInfo.description}
        aria-haspopup="listbox"
        aria-expanded={modeDrawerOpen}
      >
        <span className="truncate min-w-0">{currentModeInfo.label}</span>
        <ChevronDown className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${
            modeDrawerOpen ? "rotate-180" : ""
          }`} strokeWidth={1.5} />
      </button>

      {modeDrawerPresence.mounted && (
        <div
          role="listbox"
          onAnimationEnd={modeDrawerPresence.onAnimationEnd}
          className={`absolute bottom-full left-0 mb-2 w-64 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl surface-glass p-1 z-30 ${
            modeDrawerPresence.phase === "exit"
              ? "mobile-popover-exit"
              : "mobile-popover-enter"
          }`}
        >
          {AGENT_MODES.map((m) => {
            const active = m.value === mode;
            return (
              <button
                key={m.value}
                role="option"
                aria-selected={active}
                onClick={() => {
                  setMode(m.value as AgentMode);
                  setModeDrawerOpen(false);
                }}
                className={`
                        w-full text-left rounded-lg px-3 py-2 transition-colors duration-120
                        ${active ? "bg-indigo-500/15" : "hover:bg-fill-soft"}
                      `}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-body font-medium ${
                      active ? "text-indigo-400" : "text-fg"
                    }`}
                  >
                    {m.label}
                  </span>
                  {active && (
                    <Check size={14} strokeWidth={2} className="flex-shrink-0 text-indigo-400" aria-hidden />
                  )}
                </div>
                <p className="text-meta text-fg-secondary mt-0.5">
                  {m.description}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
