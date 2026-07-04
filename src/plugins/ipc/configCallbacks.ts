/**
 * Config-saved callback registry: plugins register a callback to be invoked
 * when their `config.json` is written via the `config.saved` virtual command.
 */

const configSavedCallbacks = new Map<string, () => void>();

export function registerConfigSavedCallback(pluginId: string, callback: () => void): void {
  configSavedCallbacks.set(pluginId, callback);
}

export function unregisterConfigSavedCallback(pluginId: string): void {
  configSavedCallbacks.delete(pluginId);
}

/** Look up the callback for a plugin. Used by `config.saved` virtual command. */
export function getConfigSavedCallback(pluginId: string): (() => void) | undefined {
  return configSavedCallbacks.get(pluginId);
}