/**
 * Plugin IPC init coordinator.
 *
 * Wires together the four extracted modules:
 *  - `commandRegistry`: command→dispatch-kind routing
 *  - `auth`: three-layer capability authorization
 *  - `eventFanout`: `plugin://events` → per-plugin `plugin-event-<id>`
 *  - `configCallbacks`: config-saved callback registry
 *
 * This file only owns the init sequence and the `plugin-request` listener;
 * all state lives in the submodules so they can be tested independently.
 */

import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { pluginCapabilityMap } from '@/lib/tauri';

import {
  ALL_COMMANDS,
  VIRTUAL_COMMANDS,
  getPluginScopedCommand,
  registerStatefulVirtualCommands,
} from './ipc/commandRegistry';
import { setCapabilityMap, isAuthorized } from './ipc/auth';
import { subscribeEvents, unsubscribeEvents, ensurePluginEventsListener } from './ipc/eventFanout';
import {
  registerConfigSavedCallback,
  unregisterConfigSavedCallback,
  getConfigSavedCallback,
} from './ipc/configCallbacks';
import { initSessionActiveBridge } from './ipc/sessionActiveBridge';

// Re-export the public registration API (consumed by plugin config views).
export { registerConfigSavedCallback, unregisterConfigSavedCallback };

interface PluginRequest {
  id: string;
  pluginId: string;
  cmd: string;
  args: Record<string, unknown>;
}

let initialized = false;

export async function initPluginIpc(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Wire event + config virtual commands (they depend on the fanout and
  // callback modules, which are only available after this point).
  registerStatefulVirtualCommands(subscribeEvents, unsubscribeEvents, getConfigSavedCallback);

  // Start fanout listener early (before any plugin subscribes).
  try {
    await ensurePluginEventsListener();
  } catch (err) {
    initialized = false;
    throw err;
  }
  // SSH tab active session → plugin events (in-process dispatch + fanout)
  initSessionActiveBridge();

  // Pull the command→capability map from the Rust single source of truth so
  // the frontend and backend never drift. The static fallback in `auth.ts`
  // is only used if this fetch fails (e.g. backend not ready during tests).
  try {
    const liveMap = await pluginCapabilityMap();
    setCapabilityMap(liveMap);
  } catch (err) {
    console.warn('[pluginIpc] failed to fetch capability map, using fallback', err);
  }

  await listen<PluginRequest>('plugin-request', async (event) => {
    const req = event.payload;
    const respond = (ok: boolean, data: unknown) => {
      emit(`plugin-response-${req.id}`, { ok, data }).catch(console.error);
    };

    const auth = isAuthorized(req.pluginId, req.cmd);
    if (!auth.ok) {
      respond(false, `command ${req.cmd} not authorized for plugin ${req.pluginId}: ${auth.reason ?? 'unknown'}`);
      return;
    }

    try {
      // Virtual commands read from frontend stores
      const virtualHandler = VIRTUAL_COMMANDS[req.cmd];
      if (virtualHandler) {
        const argsWithPluginId = { ...req.args, _pluginId: req.pluginId };
        const result = virtualHandler(argsWithPluginId);
        if (result instanceof Promise) {
          result.then((data) => respond(true, data)).catch((err) => respond(false, String(err)));
        } else {
          respond(true, result);
        }
        return;
      }

      // Plugin-scoped commands: inject pluginId as first argument
      const scopedCommand = getPluginScopedCommand(req.cmd);
      if (scopedCommand) {
        const result = await invoke(scopedCommand, {
          pluginId: req.pluginId,
          ...req.args,
        });
        respond(true, result);
        return;
      }

      // Backend commands
      const result = await invoke(req.cmd, req.args);
      respond(true, result);
    } catch (err) {
      respond(false, String(err));
    }
  });
}

// Re-export ALL_COMMANDS for any external consumer that checks command validity.
export { ALL_COMMANDS };
