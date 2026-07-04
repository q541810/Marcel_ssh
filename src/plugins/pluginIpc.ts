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

// ── Config saved callback system ──

const configSavedCallbacks = new Map<string, () => void>();

export function registerConfigSavedCallback(pluginId: string, callback: () => void): void {
  configSavedCallbacks.set(pluginId, callback);
}

export function unregisterConfigSavedCallback(pluginId: string): void {
  configSavedCallbacks.delete(pluginId);
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
    // 同 session.active：返回真实 connection ID 而非 label。
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
    // "user@host:port" label。从 label 解析出 host/port，构造一个最小信息返回，
    // 这样插件面板也能在临时连接场景下工作。
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

// Config commands: restricted to config.json only
const CONFIG_FILE = 'config.json';

VIRTUAL_COMMANDS['config.read'] = (args) => {
  const pid = args._pluginId as string ?? '';
  return invoke<string>('plugin_fs_read', { pluginId: pid, path: CONFIG_FILE });
};

VIRTUAL_COMMANDS['config.write'] = (args) => {
  const pid = args._pluginId as string ?? '';
  const content = (args.content as string) ?? '';
  return invoke('plugin_fs_write', { pluginId: pid, path: CONFIG_FILE, content });
};

VIRTUAL_COMMANDS['config.saved'] = (args) => {
  const pid = args._pluginId as string ?? '';
  const callback = configSavedCallbacks.get(pid);
  if (callback) {
    callback();
    return { ok: true };
  }
  return { ok: false, error: 'no callback registered' };
};

// All valid commands (backend + virtual + plugin-scoped)
const ALL_COMMANDS = new Set([
  ...Object.values(CAPABILITY_TO_COMMAND),
  ...Object.keys(VIRTUAL_COMMANDS),
  ...Object.keys(PLUGIN_SCOPED_COMMANDS),
]);

const COMMAND_TO_CAPABILITY: Record<string, string> = {
  // 插件发的 cmd 名（CAPABILITY_TO_COMMAND / PLUGIN_SCOPED_COMMANDS 的 key）
  // 本身就是 capability 名（如 'fs.read'、'ssh.list'），key→key 自映射即可。
  // 旧实现错把后端 tauri 命令名（'plugin_fs_read' 等）反转成 key，导致
  // isAuthorized 收到 'fs.read' 时永远查不到 capability。
  ...Object.fromEntries(Object.keys(CAPABILITY_TO_COMMAND).map((cap) => [cap, cap])),
  ...Object.fromEntries(Object.keys(PLUGIN_SCOPED_COMMANDS).map((cmd) => [cmd, cmd])),
  // Virtual commands: 命令名与 capability 不同，需显式映射
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

interface AuthResult {
  ok: boolean;
  reason?: string;
}

// 把诊断原因放进返回值，便于插件面板的 catch 块也能看到拒绝细节，
// 不需要打开主窗口 DevTools。
function isAuthorized(pluginId: string, cmd: string): AuthResult {
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

    const auth = isAuthorized(req.pluginId, req.cmd);
    if (!auth.ok) {
      respond(false, `command ${req.cmd} not authorized for plugin ${req.pluginId}: ${auth.reason ?? 'unknown'}`);
      return;
    }

    try {
      // Virtual commands read from frontend stores
      const virtualHandler = VIRTUAL_COMMANDS[req.cmd];
      if (virtualHandler) {
        // Inject pluginId for event commands
        const argsWithPluginId = { ...req.args, _pluginId: req.pluginId };
        const result = virtualHandler(argsWithPluginId);
        // Support async virtual commands (e.g. config.read, config.write)
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
