/**
 * How strongly predictive-back previews move — the handful of numbers that set
 * the feel. `backPreview.ts` reads them at the start of every gesture; the
 * mobile debug page has sliders for them so the feel can be tuned on a real
 * phone, live, and the chosen values copied back here as the defaults.
 *
 * Overrides live in this device's localStorage only (a tuning aid, not a
 * setting): with storage unavailable the defaults simply apply.
 */

export interface BackFeel {
  /** Scale lost at a full-width swipe (0.42 → the card ends at 58%); mostly in the second half. */
  shrink: number;
  /** Peak turn around the vertical axis while held, deg (toward the swipe direction). */
  turn: number;
  /** Peak pitch around the horizontal axis while held, deg (the finger's half presses in). */
  pitch: number;
  /** Horizontal drift at a full-width swipe, × screen width (also how far the throw travels). */
  shift: number;
  /** Peak vertical travel while held, px (barely any: pitch carries the vertical). */
  lift: number;
  /** Turn the card reaches when thrown off on release, deg. */
  exitTurn: number;
  /** Scale the card shrinks to when thrown off on release. */
  exitScale: number;
  /** Length of the throw-off on release, ms. */
  exitMs: number;
}

export const DEFAULT_BACK_FEEL: Readonly<BackFeel> = Object.freeze({
  shrink: 0.42,
  turn: 28,
  pitch: 20,
  shift: 0.085,
  lift: 10,
  exitTurn: 60,
  exitScale: 0.45,
  exitMs: 340,
});

/** Slider ranges for the debug panel (label, min, max, step, unit). */
export const BACK_FEEL_RANGES: ReadonlyArray<{
  key: keyof BackFeel;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}> = [
  { key: 'shrink', label: '缩小程度', min: 0.1, max: 0.7, step: 0.01, unit: '' },
  { key: 'turn', label: '左右偏转', min: 0, max: 50, step: 1, unit: '°' },
  { key: 'pitch', label: '上下倾斜', min: 0, max: 40, step: 1, unit: '°' },
  { key: 'shift', label: '左右位移', min: 0, max: 0.3, step: 0.005, unit: '×屏宽' },
  { key: 'lift', label: '上下位移', min: 0, max: 80, step: 2, unit: 'px' },
  { key: 'exitTurn', label: '松手转到', min: 20, max: 90, step: 1, unit: '°' },
  { key: 'exitScale', label: '松手缩到', min: 0.2, max: 0.9, step: 0.01, unit: '' },
  { key: 'exitMs', label: '松手动画时长', min: 160, max: 380, step: 10, unit: 'ms' },
];

const STORAGE_KEY = 'marcel:back-feel';

let current: BackFeel = load();
const listeners = new Set<() => void>();

function load(): BackFeel {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BACK_FEEL };
    const parsed = JSON.parse(raw) as Partial<Record<keyof BackFeel, unknown>>;
    const next = { ...DEFAULT_BACK_FEEL };
    for (const k of Object.keys(next) as Array<keyof BackFeel>) {
      const v = parsed[k];
      if (typeof v === 'number' && Number.isFinite(v)) next[k] = v;
    }
    return next;
  } catch {
    return { ...DEFAULT_BACK_FEEL };
  }
}

function save(): void {
  try {
    const same = (Object.keys(current) as Array<keyof BackFeel>).every(
      (k) => current[k] === DEFAULT_BACK_FEEL[k],
    );
    if (same) window.localStorage?.removeItem(STORAGE_KEY);
    else window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: the override just lasts for this session */
  }
}

/** Current values (a new object after every change, for `useSyncExternalStore`). */
export function getBackFeel(): BackFeel {
  return current;
}

export function setBackFeel(patch: Partial<BackFeel>): void {
  current = { ...current, ...patch };
  save();
  listeners.forEach((l) => l());
}

export function resetBackFeel(): void {
  setBackFeel({ ...DEFAULT_BACK_FEEL });
}

export function subscribeBackFeel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
