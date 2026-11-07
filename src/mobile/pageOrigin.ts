/**
 * Where a page was opened from — so it can grow out of that spot and, when it
 * closes, fly back into it (§7 spatial consistency: leave the way you came).
 *
 * A pure function module with one global listener: every click remembers the
 * control it landed on (the row, button or link — not the icon inside it). A
 * page that opens right after a click claims that control as its origin. No
 * call site has to pass anything, so every page opened by a tap gets the
 * effect, and a page opened some other way (a notification, a jump from
 * another screen) simply has no origin and uses the fallback.
 *
 * Mark an element with `data-back-origin` to make it the origin instead of the
 * control inside it (e.g. a whole card whose inner button was the click).
 */

/** A click older than this is not what opened the page. */
const CLAIM_WINDOW_MS = 1000;

const CONTROL_SELECTOR =
  '[data-back-origin], button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], li';

let last: { el: Element; t: number } | null = null;

function remember(e: Event): void {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const el = target.closest(CONTROL_SELECTOR);
  if (el) last = { el, t: performance.now() };
}

if (typeof window !== 'undefined') {
  // Capture phase: runs before React's handlers, which open the page.
  window.addEventListener('click', remember, true);
}

/**
 * Take the control the user just pressed as the origin of a page that is
 * opening now (`page` itself is excluded). Null when nothing was pressed
 * recently. Not consumed: a page that re-runs its open (React StrictMode,
 * a remount within the same tap) must find the same origin again.
 */
export function claimOrigin(page: Element | null): Element | null {
  const l = last;
  if (!l || performance.now() - l.t > CLAIM_WINDOW_MS) return null;
  if (page && (page === l.el || page.contains(l.el))) return null;
  return l.el;
}

/** Test helper: forget the remembered click. */
export function __resetOrigin(): void {
  last = null;
}
