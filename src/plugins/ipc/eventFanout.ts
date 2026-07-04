/**
 * Event fanout: subscribes to the single backend `plugin://events` listener
 * and forwards to per-plugin `plugin-event-<id>` channels based on pattern
 * subscriptions.
 *
 * Pattern matching: `prefix/*` matches any event starting with `prefix/`;
 * otherwise exact string match.
 */

import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';

import { matchPattern } from '../pattern';

// Re-export so existing importers don't break; the single source of truth is
// `plugins/pattern.ts`.
export { matchPattern };

/** Per-plugin subscription tracking: pluginId → Set<eventPattern>. */
const pluginSubscriptions = new Map<string, Set<string>>();

/** Single listener for all plugin events from the backend. */
let pluginEventsListener: Promise<UnlistenFn> | null = null;

function ensurePluginEventsListener(): void {
  if (pluginEventsListener) return;
  pluginEventsListener = listen<{ event: string; data: unknown }>('plugin://events', (e) => {
    forwardToPlugins(e.payload.event, e.payload.data);
  });
}

function forwardToPlugins(event: string, data: unknown): void {
  for (const [pluginId, patterns] of pluginSubscriptions) {
    for (const pattern of patterns) {
      if (matchPattern(pattern, event)) {
        emit(`plugin-event-${pluginId}`, { event, data }).catch(console.error);
        break;
      }
    }
  }
}

/** Subscribe a plugin to a set of event patterns. Returns the subscribed list. */
export function subscribeEvents(pluginId: string, events: string[]): string[] {
  if (!pluginSubscriptions.has(pluginId)) {
    pluginSubscriptions.set(pluginId, new Set());
  }
  const subs = pluginSubscriptions.get(pluginId)!;
  const subscribed: string[] = [];

  for (const ev of events) {
    subs.add(ev);
    subscribed.push(ev);
  }

  if (subscribed.length > 0) {
    ensurePluginEventsListener();
  }

  return subscribed;
}

/** Unsubscribe a plugin from event patterns. Returns the unsubscribed list. */
export function unsubscribeEvents(pluginId: string, events: string[]): string[] {
  const subs = pluginSubscriptions.get(pluginId);
  if (!subs) return [];
  const unsubscribed: string[] = [];
  for (const ev of events) {
    if (subs.delete(ev)) {
      unsubscribed.push(ev);
    }
  }
  return unsubscribed;
}

/** Remove all subscriptions for a plugin (e.g. on plugin disable/unload). */
export function removePluginSubscriptions(pluginId: string): void {
  pluginSubscriptions.delete(pluginId);
}