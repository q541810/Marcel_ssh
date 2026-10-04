import { bus } from "@/plugins/injection/bus";

// ── Plugin input-activity bridge ──────────────────────────────────────
// Emits `ui://input-activity` (typing bool only — never the content) so
// plugins such as a desktop pet can reflect "user is typing". Throttled:
// only fires on state change, and auto-resets to false after 600ms idle.
let __inputActivityTimer: number | null = null;
let __lastTypingState = false;
function emitInputActivity(typing: boolean) {
  if (typing === __lastTypingState) return;
  __lastTypingState = typing;
  bus.emit("ui://input-activity", { typing });
}
export function notifyInputTyping() {
  emitInputActivity(true);
  if (__inputActivityTimer !== null) window.clearTimeout(__inputActivityTimer);
  __inputActivityTimer = window.setTimeout(() => emitInputActivity(false), 600);
}
export function notifyInputStopped() {
  if (__inputActivityTimer !== null) {
    window.clearTimeout(__inputActivityTimer);
    __inputActivityTimer = null;
  }
  emitInputActivity(false);
}
