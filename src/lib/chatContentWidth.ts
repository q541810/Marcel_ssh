/**
 * Agent 聊天内容列的宽度规则（参考 DSH ui-conversation 的
 * resolveContentWidth / WIDTH_PREF_KEY）：自适应 clamp + 用户拖拽偏好。
 * 纯逻辑放这里，把手组件（panel/ContentWidthHandles）只做手势。
 */

/** localStorage key for the dragged transcript width preference (px). */
export const CHAT_CONTENT_WIDTH_KEY = 'marcel:chatContentWidth';
/** Floor for a dragged content width; below this the chat becomes unusable. */
export const CONTENT_MIN = 640;
/** Column budget the content must leave free: 88px per side keeps the width
 *  handles fully placeable (24px inset + 40px strip + 24px safe zone) — a
 *  larger dragged width would push its own handles off the column and leave no
 *  way to drag back. */
export const CONTENT_EDGE_BUDGET = 176;

/** Reads the persisted width preference; durable-storage boundary, so a
 *  missing or corrupt value resolves to "no preference". */
export function readChatWidthPreference(): number | null {
  try {
    const raw = localStorage.getItem(CHAT_CONTENT_WIDTH_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeChatWidthPreference(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(CHAT_CONTENT_WIDTH_KEY);
    else localStorage.setItem(CHAT_CONTENT_WIDTH_KEY, String(width));
  } catch {
    // Storage can be unavailable; the live preview still worked this session.
  }
}

/** 面板宽度 → 内容列实际宽度：有拖拽偏好按偏好钳到 [CONTENT_MIN, 面板宽−预算]，
 *  没有偏好用自适应式 max(680, min(面板宽×0.64, 920))。与 CSS clamp 同口径。 */
export function resolveAgentContentWidth(panelWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, panelWidth - CONTENT_EDGE_BUDGET);
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max);
  return Math.max(680, Math.min(panelWidth * 0.64, 920));
}
