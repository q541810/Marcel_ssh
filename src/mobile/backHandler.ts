/**
 * Android back-gesture handler for the mobile shell.
 *
 * The native side (MainActivity.onWebViewCreate) evaluates
 * `window.__marcelHandleBack()` when the user swipes back. Returning true
 * means the web layer consumed the event (a sheet closed, a sub-page popped);
 * false lets the system finish the activity.
 *
 * Layers register a close callback on mount and unregister on unmount; the
 * topmost (most recently opened) layer consumes the back press first.
 */

type BackCloseFn = () => void;

const stack: BackCloseFn[] = [];

function popAndClose(): boolean {
  const close = stack[stack.length - 1];
  if (close == null) return false;
  // Remove before invoking: close() triggers React state updates that will
  // synchronously run the layer's cleanup, which would otherwise try to
  // unregister the same entry twice.
  stack.pop();
  close();
  return true;
}

declare global {
  interface Window {
    __marcelHandleBack?: () => boolean;
  }
}

if (typeof window !== 'undefined') {
  window.__marcelHandleBack = popAndClose;
}

/**
 * Register a layer that should consume the next Android back press. Returns an
 * unregister function — call it from the owning component's cleanup. Calling
 * unregister for a layer that was already popped is a no-op.
 */
export function registerBackHandler(close: BackCloseFn): () => void {
  stack.push(close);
  return () => {
    const idx = stack.lastIndexOf(close);
    if (idx >= 0) stack.splice(idx, 1);
  };
}

/** Test helper / escape hatch. */
export function resetBackHandlers(): void {
  stack.length = 0;
}
