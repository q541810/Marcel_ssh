import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';

interface PluginRequest {
  id: string;
  pluginId: string;
  cmd: string;
  args: Record<string, unknown>;
}

// Backend commands: capability → tauri command
// These commands pass args directly to invoke without modification
const CAPABILITY_TO_COMMAND: Record<string, string> = {
  'ssh.list': 'ssh_list_sessions',
  'ssh.exec': 'ssh_exec',
  'sftp.read': 'sftp_read_file',
  'sftp.write': 'sftp_write_file',
};

// Plugin-scoped commands: automatically inject pluginId as first argument
const PLUGIN_SCOPED_COMMANDS: Record<string, string> = {
  'fs.read': 'plugin_fs_read',
  'fs.write': 'plugin_fs_write',
  'net.request': 'plugin_http_request',
  'notification': 'plugin_send_notification',
};

// Virtual commands: read from frontend stores (no backend invoke)
const VIRTUAL_COMMANDS: Record<string, (args: Record<string, unknown>) => unknown> = {
  'session.active': () => {
    const { sessions, activeSessionId } = useSessionStore.getState();
    if (!activeSessionId) return null;
    const session = sessions[activeSessionId];
    if (!session) return null;
    return {
      sessionId: session.id,
      connectionId: session.connectionId,
      status: session.status,
      configId: session.configId ?? null,
    };
  },
  'session.info': (args) => {
    const sessionId = args.sessionId as string;
    if (!sessionId) return null;
    const session = useSessionStore.getState().sessions[sessionId];
    if (!session) return null;
    return {
      sessionId: session.id,
      connectionId: session.connectionId,
      status: session.status,
      createdAt: session.createdAt,
      configId: session.configId ?? null,
    };
  },
  'connection.info': (args) => {
    const connectionId = args.connectionId as string;
    if (!connectionId) return null;
    const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
    if (!conn) return null;
    return {
      id: conn.id,
      name: conn.name,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      group: conn.group ?? null,
    };
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

// All valid commands (backend + virtual + plugin-scoped)
const ALL_COMMANDS = new Set([
  ...Object.values(CAPABILITY_TO_COMMAND),
  ...Object.keys(VIRTUAL_COMMANDS),
  ...Object.keys(PLUGIN_SCOPED_COMMANDS),
]);

const COMMAND_TO_CAPABILITY: Record<string, string> = {
  ...Object.fromEntries(Object.entries(CAPABILITY_TO_COMMAND).map(([cap, cmd]) => [cmd, cap])),
  ...Object.fromEntries(Object.entries(PLUGIN_SCOPED_COMMANDS).map(([cap, cmd]) => [cmd, cap])),
  'session.active': 'ssh.list',
  'session.info': 'ssh.list',
  'connection.info': 'ssh.list',
  'connection.list': 'ssh.list',
};

function isAuthorized(pluginId: string, cmd: string): boolean {
  const manifest = usePluginStore.getState().manifests.find((m) => m.id === pluginId);
  if (!manifest) return false;

  if (!ALL_COMMANDS.has(cmd)) return false;

  const required = COMMAND_TO_CAPABILITY[cmd];
  if (!required) return false;

  const settings = useSettingsStore.getState().settings;
  const authorizedMap = settings.authorizedCapabilities ?? {};

  // Plugin not in map → all declared capabilities are authorized (backward compatible)
  if (!(pluginId in authorizedMap)) {
    return manifest.capabilities.includes(required);
  }

  // Plugin in map → only listed capabilities are authorized
  const authorizedList = authorizedMap[pluginId] ?? [];
  return authorizedList.includes(required);
}

function getPluginScopedCommand(cmd: string): string | null {
  return PLUGIN_SCOPED_COMMANDS[cmd] ?? null;
}

let initialized = false;

export async function initPluginIpc(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await listen<PluginRequest>('plugin-request', async (event) => {
    const req = event.payload;
    const respond = (ok: boolean, data: unknown) => {
      emit(`plugin-response-${req.id}`, { ok, data }).catch(console.error);
    };

    if (!isAuthorized(req.pluginId, req.cmd)) {
      respond(false, `command ${req.cmd} not authorized for plugin ${req.pluginId}`);
      return;
    }

    try {
      // Virtual commands read from frontend stores
      const virtualHandler = VIRTUAL_COMMANDS[req.cmd];
      if (virtualHandler) {
        respond(true, virtualHandler(req.args));
        return;
      }

      // Plugin-scoped commands: inject pluginId as first argument
      const scopedCommand = getPluginScopedCommand(req.cmd);
      if (scopedCommand) {
        const result = await invoke(scopedCommand, { pluginId: req.pluginId, ...req.args });
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
