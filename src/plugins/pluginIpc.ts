import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
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

// ── Event subscription system ──

// Per-plugin subscription tracking: pluginId → Set<eventPattern>
const pluginSubscriptions = new Map<string, Set<string>>();

// Single listener for all plugin events from the backend
let pluginEventsListener: Promise<UnlistenFn> | null = null;

function matchPattern(pattern: string, event: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // keep the /
    return event.startsWith(prefix);
  }
  return pattern === event;
}

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

function subscribeEvents(pluginId: string, events: string[]): string[] {
  if (!pluginSubscriptions.has(pluginId)) {
    pluginSubscriptions.set(pluginId, new Set());
  }
  const subs = pluginSubscriptions.get(pluginId)!;
  const subscribed: string[] = [];

  for (const ev of events) {
    subs.add(ev);
    subscribed.push(ev);
  }

  // Ensure the single listener is active
  if (subscribed.length > 0) {
    ensurePluginEventsListener();
  }

  return subscribed;
}

function unsubscribeEvents(pluginId: string, events: string[]): string[] {
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

function removePluginSubscriptions(pluginId: string): void {
  pluginSubscriptions.delete(pluginId);
}

// Add event commands to virtual commands
VIRTUAL_COMMANDS['events.subscribe'] = (args) => {
  const events = (args.events as string[]) ?? [];
  const pid = args._pluginId as string ?? '';
  const subscribed = subscribeEvents(pid, events);
  return { subscribed };
};

VIRTUAL_COMMANDS['events.unsubscribe'] = (args) => {
  const events = (args.events as string[]) ?? [];
  const pid = args._pluginId as string ?? '';
  const unsubscribed = unsubscribeEvents(pid, events);
  return { unsubscribed };
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
  'events.subscribe': 'events',
  'events.unsubscribe': 'events',
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
        // Inject pluginId for event commands
        const argsWithPluginId = { ...req.args, _pluginId: req.pluginId };
        respond(true, virtualHandler(argsWithPluginId));
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
