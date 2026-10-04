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
                flex w-full min-w-0 items-center gap-1 px-2 py-1.5 text-xs font-medium transition-colors rounded-full
                ${
                  modeDrawerOpen
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
                }
              `}
        title={currentModeInfo.description}
        aria-haspopup="listbox"
        aria-expanded={modeDrawerOpen}
      >
        <span className="truncate min-w-0">{currentModeInfo.label}</span>
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${
            modeDrawerOpen ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {modeDrawerPresence.mounted && (
        <div
          role="listbox"
          onAnimationEnd={modeDrawerPresence.onAnimationEnd}
          className={`absolute bottom-full left-0 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl py-1 z-30 ${
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
                        w-full text-left px-3 py-2 transition-colors
                        ${
                          active
                            ? "bg-indigo-600/20 border-l-2 border-indigo-500"
                            : "hover:bg-zinc-700 border-l-2 border-transparent"
                        }
                      `}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-sm font-semibold ${
                      active ? "text-indigo-300" : "text-zinc-200"
                    }`}
                  >
                    {m.label}
                  </span>
                  {active && (
                    <span className="text-xs text-indigo-400">
                      已选
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
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
