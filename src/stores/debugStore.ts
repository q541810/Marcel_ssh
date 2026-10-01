import { create } from "zustand";

/** Fallback values used only by the debug force-show switch. */
export const DEBUG_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "ultra"];

const LIGHT_MODE_KEY = "marcel.debug.lightMode";
const DEBUG_67_MODE_KEY = "marcel.debug.67Mode";
const DEBUG_67_TOKEN_LIMIT_KEY = "marcel.debug.67TokenLimit";
const DEBUG_67_SPEED_KEY = "marcel.debug.67Speed";
const DEBUG_67_THINKING_KEY = "marcel.debug.67Thinking";
export const DEBUG_67_DEFAULT_TOKEN_LIMIT = 1000;
export const DEBUG_67_DEFAULT_SPEED = 8;
export const DEBUG_67_MIN_TOKEN_LIMIT = 1;
export const DEBUG_67_MAX_TOKEN_LIMIT = 100000;
export const DEBUG_67_MIN_SPEED = 1;
export const DEBUG_67_MAX_SPEED = 30;

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(key, "1");
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage can be unavailable in private WebViews; the in-memory switch still works.
  }
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  } catch {
    return fallback;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    // Storage can be unavailable in private WebViews; memory state still works.
  }
}

function applyLightMode(enabled: boolean): void {
  if (typeof document === "undefined") return;
  if (enabled) document.documentElement.dataset.marcelTheme = "light";
  else if (document.documentElement.dataset.marcelTheme === "light") {
    delete document.documentElement.dataset.marcelTheme;
  }
}

const initialLightMode = readFlag(LIGHT_MODE_KEY);
const initial67Mode = readFlag(DEBUG_67_MODE_KEY);
const initial67TokenLimit = readNumber(
  DEBUG_67_TOKEN_LIMIT_KEY,
  DEBUG_67_DEFAULT_TOKEN_LIMIT,
  DEBUG_67_MIN_TOKEN_LIMIT,
  DEBUG_67_MAX_TOKEN_LIMIT,
);
const initial67Speed = readNumber(
  DEBUG_67_SPEED_KEY,
  DEBUG_67_DEFAULT_SPEED,
  DEBUG_67_MIN_SPEED,
  DEBUG_67_MAX_SPEED,
);
const initial67Thinking = readFlag(DEBUG_67_THINKING_KEY);
applyLightMode(initialLightMode);

interface DebugState {
  forceReasoningEffortPicker: boolean;
  setForceReasoningEffortPicker: (enabled: boolean) => void;
  /** Runtime-only experimental theme switch exposed from the debug page. */
  lightMode: boolean;
  setLightMode: (enabled: boolean) => void;
  /** Persisted debug simulation: requests produce only repeated "67" output. */
  debug67Mode: boolean;
  setDebug67Mode: (enabled: boolean) => void;
  debug67TokenLimit: number;
  setDebug67TokenLimit: (value: number) => void;
  debug67Speed: number;
  setDebug67Speed: (value: number) => void;
  debug67Thinking: boolean;
  setDebug67Thinking: (enabled: boolean) => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  forceReasoningEffortPicker: false,
  setForceReasoningEffortPicker: (enabled) =>
    set({ forceReasoningEffortPicker: enabled }),
  lightMode: initialLightMode,
  setLightMode: (enabled) => {
    writeFlag(LIGHT_MODE_KEY, enabled);
    applyLightMode(enabled);
    set({ lightMode: enabled });
  },
  debug67Mode: initial67Mode,
  setDebug67Mode: (enabled) => {
    writeFlag(DEBUG_67_MODE_KEY, enabled);
    set({ debug67Mode: enabled });
  },
  debug67TokenLimit: initial67TokenLimit,
  setDebug67TokenLimit: (value) => {
    const safe = Number.isFinite(value) ? value : DEBUG_67_DEFAULT_TOKEN_LIMIT;
    const next = Math.min(DEBUG_67_MAX_TOKEN_LIMIT, Math.max(DEBUG_67_MIN_TOKEN_LIMIT, Math.round(safe)));
    writeNumber(DEBUG_67_TOKEN_LIMIT_KEY, next);
    set({ debug67TokenLimit: next });
  },
  debug67Speed: initial67Speed,
  setDebug67Speed: (value) => {
    const safe = Number.isFinite(value) ? value : DEBUG_67_DEFAULT_SPEED;
    const next = Math.min(DEBUG_67_MAX_SPEED, Math.max(DEBUG_67_MIN_SPEED, Math.round(safe)));
    writeNumber(DEBUG_67_SPEED_KEY, next);
    set({ debug67Speed: next });
  },
  debug67Thinking: initial67Thinking,
  setDebug67Thinking: (enabled) => {
    writeFlag(DEBUG_67_THINKING_KEY, enabled);
    set({ debug67Thinking: enabled });
  },
}));
