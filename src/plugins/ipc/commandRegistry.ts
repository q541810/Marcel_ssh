/**
 * Command registry: maps plugin-facing command names to their dispatch type.
 *
 * Three dispatch kinds:
 *  - `virtual`: handled in the frontend (reads from stores / invokes backend
 *    fs commands for config). No generic backend invoke.
 *  - `pluginScoped`: a backend Tauri command that needs `pluginId` injected
 *    as the first argument (e.g. `plugin_fs_read`).
 *  - `backend`: a backend Tauri command that takes args verbatim.
 *
 * The capability→command and command→capability tables are owned by the Rust
 * `plugins::capability` module and pulled at init time by `pluginIpc.ts`.
 * This module only owns the dispatch routing, not the capability mapping.
 */

import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';

/** Backend Tauri commands that take args verbatim (capability-named). */
export const CAPABILITY_TO_COMMAND: Record<string, string> = {
  'ssh.list': 'ssh_list_sessions',
  'ssh.exec': 'ssh_exec',
  'sftp.read': 'sftp_read_file',
  'sftp.write': 'sftp_write_file',
};

/** Backend Tauri commands that need `pluginId` injected as first arg. */
export const PLUGIN_SCOPED_COMMANDS: Record<string, string> = {
  'fs.read': 'plugin_fs_read',
  'fs.write': 'plugin_fs_write',
  'net.request': 'plugin_http_request',
  'notification': 'plugin_send_notification',
  // ── window.create family (independent OS-level windows) ──
  'window.create': 'plugin_window_create',
  'window.show': 'plugin_window_show',
  'window.hide': 'plugin_window_hide',
  'window.close': 'plugin_window_close',
  'window.focus': 'plugin_window_focus',
  'window.set_position': 'plugin_window_set_position',
  'window.set_size': 'plugin_window_set_size',
  'window.set_always_on_top': 'plugin_window_set_always_on_top',
  'window.set_ignore_cursor_events': 'plugin_window_set_ignore_cursor_events',
  // ── context_menu ──
  'menu.register': 'plugin_menu_register',
  'menu.update': 'plugin_menu_update',
  'menu.unregister': 'plugin_menu_unregister',
  'menu.popup': 'plugin_menu_popup',
};

/** Virtual commands handled entirely in the frontend. */
export const VIRTUAL_COMMANDS: Record<string, (args: Record<string, unknown>) => unknown> = {
  'session.active': () => {
    const { sessions, activeSessionId } = useSessionStore.getState();
    if (!activeSessionId) return null;
    const session = sessions[activeSessionId];
    if (!session) return null;
    // connectionStore 的 connection.id 是 saved connection 的真实 UUID。
    // session.connectionId 实际是 "user@host:port" label（不可用于查找），
    // session.configId 才是真正匹配 connection.id 的 UUID。优先返回 configId，
    // 这样后续 connection.info 才能在 store 里 find 到。
    const realConnectionId = session.configId ?? session.connectionId;
    return {
      sessionId: session.id,
      connectionId: realConnectionId,
      status: session.status,
      configId: session.configId ?? null,
    };
  },
  'session.info': (args) => {
    const sessionId = args.sessionId as string;
    if (!sessionId) return null;
    const session = useSessionStore.getState().sessions[sessionId];
    if (!session) return null;
    const realConnectionId = session.configId ?? session.connectionId;
    return {
      sessionId: session.id,
      connectionId: realConnectionId,
      status: session.status,
      createdAt: session.createdAt,
      configId: session.configId ?? null,
    };
  },
  'connection.info': (args) => {
    const connectionId = args.connectionId as string;
    if (!connectionId) return null;
    const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
    if (conn) {
      return {
        id: conn.id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        group: conn.group ?? null,
      };
    }
    // 降级：临时连接（未保存到 connectionStore）的情况，connectionId 实际是
    // "user@host:port" label。从 label 解析出 host/port，构造一个最小信息返回。
    const parts = connectionId.split('@');
    if (parts.length >= 2) {
      const userPart = parts[0];
      const hostPort = parts[parts.length - 1];
      const [host, portStr] = hostPort.split(':');
      const port = parseInt(portStr, 10);
      if (host && !isNaN(port)) {
        return {
          id: connectionId,
          name: connectionId,
          host,
          port,
          username: userPart,
          group: null,
        };
      }
    }
    return null;
  },
  'connection.list': () => {
    return useConnectionStore.getState().connections.map((c) => ({
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      group: c.group ?? null,
    }));
  },
};

/** All valid command names (for `isAuthorized` validation).
 *
 *  NOTE: stateful virtual commands (`events.subscribe` / `config.*`) are
 *  registered later via `registerStatefulVirtualCommands`, which extends this
 *  set too. Without that, `isAuthorized` rejects them as unknown commands and
 *  event subscription / config persistence silently break for every plugin. */
export const ALL_COMMANDS = new Set([
  ...Object.values(CAPABILITY_TO_COMMAND),
  ...Object.keys(VIRTUAL_COMMANDS),
  ...Object.keys(PLUGIN_SCOPED_COMMANDS),
]);

/** Config file restriction for `config.read`/`config.write` virtual commands. */
const CONFIG_FILE = 'config.json';

/** Register the event + config virtual commands (depend on other modules). */
export function registerStatefulVirtualCommands(
  subscribeEvents: (pluginId: string, events: string[]) => string[],
  unsubscribeEvents: (pluginId: string, events: string[]) => string[],
  getConfigSavedCallback: (pluginId: string) => (() => void) | undefined,
): void {
  VIRTUAL_COMMANDS['events.subscribe'] = (args) => {
    const events = (args.events as string[]) ?? [];
    const pid = (args._pluginId as string) ?? '';
    const subscribed = subscribeEvents(pid, events);
    return { subscribed };
  };
  ALL_COMMANDS.add('events.subscribe');

  VIRTUAL_COMMANDS['events.unsubscribe'] = (args) => {
    const events = (args.events as string[]) ?? [];
    const pid = (args._pluginId as string) ?? '';
    const unsubscribed = unsubscribeEvents(pid, events);
    return { unsubscribed };
  };
  ALL_COMMANDS.add('events.unsubscribe');

  VIRTUAL_COMMANDS['config.read'] = (args) => {
    const pid = (args._pluginId as string) ?? '';
    return invoke<string>('plugin_fs_read', { pluginId: pid, path: CONFIG_FILE });
  };
  ALL_COMMANDS.add('config.read');

  VIRTUAL_COMMANDS['config.write'] = (args) => {
    const pid = (args._pluginId as string) ?? '';
    const content = (args.content as string) ?? '';
    return invoke('plugin_fs_write', { pluginId: pid, path: CONFIG_FILE, content });
  };
  ALL_COMMANDS.add('config.write');

  VIRTUAL_COMMANDS['config.saved'] = (args) => {
    const pid = (args._pluginId as string) ?? '';
    const callback = getConfigSavedCallback(pid);
    if (callback) {
      callback();
      return { ok: true };
    }
    return { ok: false, error: 'no callback registered' };
  };
  ALL_COMMANDS.add('config.saved');
}

/** Look up the plugin-scoped backend command for a given cmd, if any. */
export function getPluginScopedCommand(cmd: string): string | null {
  return PLUGIN_SCOPED_COMMANDS[cmd] ?? null;
}