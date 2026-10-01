import type { SavedConnection } from '@/lib/types';

export const DEBUG_SERVER_ID = 'debug:msfakeserver';
export const DEBUG_SERVER_PROMPT = 'msfakeserver$:';

export function isDebugConnection(id: string | null | undefined): boolean {
  return id === DEBUG_SERVER_ID;
}

export function isDebugSession(id: string | null | undefined): boolean {
  return id?.startsWith('debug-session:') ?? false;
}

export function createDebugServer(): SavedConnection {
  return {
    id: DEBUG_SERVER_ID,
    name: 'msfakeserver',
    host: 'msfakeserver',
    port: 22,
    username: 'debug',
    authMethod: 'Debug',
    group: '调试',
  };
}

/** Refreshes saved connections without discarding the temporary local debug server. */
export function mergeDebugServer(saved: SavedConnection[], current: SavedConnection[]): SavedConnection[] {
  return [
    ...saved.filter((connection) => !isDebugConnection(connection.id)),
    ...current.filter((connection) => isDebugConnection(connection.id)),
  ];
}
