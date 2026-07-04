/**
 * Plugin capability authorization — frontend mirror of the Rust
 * `plugins::auth::authorize` three-layer policy.
 *
 *   1. manifest declares the capability
 *   2. user has authorized the capability for this plugin
 *      (plugin absent from `authorizedCapabilities` → all declared ok)
 *
 * (Plugin-enabled check is implicit: `pluginStore.manifests` only contains
 * enabled plugins, so a disabled plugin's manifest is absent and auth fails
 * at layer 1 with "manifest not found".)
 *
 * The `COMMAND_TO_CAPABILITY` map is populated at init time from the Rust
 * single source of truth by `pluginIpc.ts`. A static fallback is used only
 * if the IPC fetch fails.
 */

import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  ALL_COMMANDS,
  CAPABILITY_TO_COMMAND,
  PLUGIN_SCOPED_COMMANDS,
} from './commandRegistry';

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

/** Static fallback mapping; replaced at init by the Rust source of truth. */
const FALLBACK_COMMAND_TO_CAPABILITY: Record<string, string> = {
  ...Object.fromEntries(Object.keys(CAPABILITY_TO_COMMAND).map((cap) => [cap, cap])),
  ...Object.fromEntries(Object.keys(PLUGIN_SCOPED_COMMANDS).map((cmd) => [cmd, cmd])),
  'session.active': 'ssh.list',
  'session.info': 'ssh.list',
  'connection.info': 'ssh.list',
  'connection.list': 'ssh.list',
  'events.subscribe': 'events',
  'events.unsubscribe': 'events',
  'config.read': 'fs.read',
  'config.write': 'fs.write',
  'config.saved': 'fs.write',
};

/** Live map, populated at init by `pluginIpc.ts`. */
let COMMAND_TO_CAPABILITY: Record<string, string> = { ...FALLBACK_COMMAND_TO_CAPABILITY };

/** Replace the capability map with the Rust-provided one. Called once at init. */
export function setCapabilityMap(map: Record<string, string>): void {
  if (map && Object.keys(map).length > 0) {
    COMMAND_TO_CAPABILITY = map;
  }
}

/**
 * Check whether `pluginId` may invoke `cmd`. Carries a diagnostic reason on
 * denial so plugin DevTools can surface it without opening the main window.
 */
export function isAuthorized(pluginId: string, cmd: string): AuthResult {
  const manifests = usePluginStore.getState().manifests;
  const manifest = manifests.find((m) => m.id === pluginId);
  if (!manifest) {
    return {
      ok: false,
      reason: `manifest not found for pluginId="${pluginId}" (loaded manifests: ${JSON.stringify(manifests.map(m => m.id))})`,
    };
  }

  if (!ALL_COMMANDS.has(cmd)) {
    return { ok: false, reason: `unknown command "${cmd}"` };
  }

  const required = COMMAND_TO_CAPABILITY[cmd];
  if (!required) {
    return { ok: false, reason: `no capability mapping for "${cmd}"` };
  }

  const settings = useSettingsStore.getState().settings;
  const authorizedMap = settings.authorizedCapabilities ?? {};

  // Plugin not in map → all declared capabilities are authorized (backward compatible)
  if (!(pluginId in authorizedMap)) {
    const ok = manifest.capabilities.includes(required);
    if (!ok) {
      return {
        ok: false,
        reason: `capability "${required}" not declared by "${pluginId}" (declared: ${JSON.stringify(manifest.capabilities)})`,
      };
    }
    return { ok: true };
  }

  // Plugin in map → only listed capabilities are authorized
  const authorizedList = authorizedMap[pluginId] ?? [];
  const ok = authorizedList.includes(required);
  if (!ok) {
    return {
      ok: false,
      reason: `capability "${required}" not in authorizedList for "${pluginId}" (authorized: ${JSON.stringify(authorizedList)})`,
    };
  }
  return { ok: true };
}