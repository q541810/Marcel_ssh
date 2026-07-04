import { pluginWebviewCreate, pluginWebviewSetBounds, pluginWebviewClose } from '@/lib/tauri';

interface PooledWebView {
  label: string;
  pluginId: string;
  entry: string;
  lastUsed: number;
}

const pool = new Map<string, PooledWebView>();
const MAX_POOL_SIZE = 5;

function evictOldest(): void {
  if (pool.size === 0) return;

  let oldestLabel = '';
  let oldestTime = Infinity;

  for (const [label, entry] of pool) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestLabel = label;
    }
  }

  if (oldestLabel) {
    pool.delete(oldestLabel);
    pluginWebviewClose(oldestLabel).catch(console.error);
  }
}

export async function acquire(
  label: string,
  pluginId: string,
  entry: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  const existing = pool.get(label);
  if (existing) {
    existing.lastUsed = Date.now();
    await pluginWebviewSetBounds(label, x, y, width, height).catch(() => {});
    return;
  }

  if (pool.size >= MAX_POOL_SIZE) {
    evictOldest();
  }

  try {
    await pluginWebviewCreate(label, pluginId, entry, x, y, width, height);
  } catch (err) {
    // 后端可能已有该 label 的 WebView（残留或竞态），视为成功
    if (!String(err).includes('already exists')) {
      throw err;
    }
  }

  pool.set(label, {
    label,
    pluginId,
    entry,
    lastUsed: Date.now(),
  });

  await pluginWebviewSetBounds(label, x, y, width, height).catch(() => {});
}

export async function hide(label: string): Promise<void> {
  if (!pool.has(label)) return;
  await pluginWebviewSetBounds(label, 0, 0, 0, 0).catch(() => {});
}

export async function destroy(label: string): Promise<void> {
  if (!pool.has(label)) return;
  pool.delete(label);
  await pluginWebviewClose(label).catch(() => {});
}

export async function destroyByPlugin(pluginId: string): Promise<void> {
  const toDestroy: string[] = [];
  for (const [label, entry] of pool) {
    if (entry.pluginId === pluginId) {
      toDestroy.push(label);
    }
  }
  for (const label of toDestroy) {
    pool.delete(label);
    pluginWebviewClose(label).catch(console.error);
  }
}

export async function destroyAll(): Promise<void> {
  const labels = Array.from(pool.keys());
  pool.clear();
  await Promise.all(
    labels.map((label) => pluginWebviewClose(label).catch(console.error)),
  );
}

/**
 * Reconcile the frontend pool with the backend's live plugin set. Any pooled
 * webview whose plugin is no longer in `livePluginIds` is destroyed. Called
 * after a registry reload so webviews for deleted/disabled plugins don't
 * linger on the frontend while the backend has already torn them down.
 */
export async function resync(livePluginIds: Set<string>): Promise<void> {
  const toDestroy: string[] = [];
  for (const [label, entry] of pool) {
    if (!livePluginIds.has(entry.pluginId)) {
      toDestroy.push(label);
    }
  }
  for (const label of toDestroy) {
    pool.delete(label);
    pluginWebviewClose(label).catch(console.error);
  }
}
