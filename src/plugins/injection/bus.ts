/**
 * Local in-memory event bus shared by the UI region bridge and content-script
 * runtime. Used for:
 *  - UI bridge events emitted by the main app (`ui:nav-change`,
 *    `ui:region-mounted`, `ui:region-unmounted`)
 *  - Plugin-to-plugin / plugin-to-self events via `marcel.events.emit`
 *
 * Backend events (e.g. `ssh://status/*`) are NOT routed here — they arrive as
 * Tauri `plugin-event-<pluginId>` events and are dispatched by `pluginApi.ts`
 * after pattern matching.
 */

type Handler = (data: unknown) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      const s = this.handlers.get(event);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, data?: unknown): void {
    // Snapshot to avoid mutation-during-iteration issues if a handler
    // subscribes/unsubscribes during dispatch.
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of Array.from(set)) {
      try {
        h(data);
      } catch (err) {
        console.error('[injection-bus] handler error for', event, err);
      }
    }
  }

  /** Remove every handler. Used on full teardown. */
  clear(): void {
    this.handlers.clear();
  }
}

/** Singleton bus shared across the injection engine. */
export const bus = new EventBus();

export type { Handler };
