import { pluginWebviewCreate, pluginWebviewSetBounds, pluginWebviewClose } from '@/lib/tauri';
import { parseAppError } from '@/lib/errors';

interface PooledWebView {
  label: string;
  pluginId: string;
  entry: string;
  lastUsed: number;
}

const pool = new Map<string, PooledWebView>();
const MAX_POOL_SIZE = 5;

/**
 * 这条错误是不是「该 label 的 WebView 已经存在」。
 *
 * 后端 `plugin_webview_create` 对"已存在"有两条表态，两条都得认：
 * 1. 命令签名是 `Result<(), String>`，Tauri 把原话（`Error::WebviewLabelAlreadyExists`
 *    的 "a webview with label `x` already exists"）当裸字符串抛回来；
 * 2. 后端改用结构化 `AppError` 后，原话在 `message` 里。
 * 所以取原文一律经 `parseAppError`（`getErrorMessage` 同一口径）——`String(err)` 在
 * 结构化错误上得到 "[object Object]"，这一分支会静默失效：本该当作成功的竞态反而
 * 抛错，插槽显示"插件加载失败"。匹配的是 Tauri 的错误原文，不是界面文案。
 *
 * 若后端愿意给机器可读原因，最稳的形态是 `AppError` + `data.code = "webview_already_exists"`，
 * 届时这里再加一条按码判断（现在不凭空造一个后端不会发的码）。
 */
const WEBVIEW_ALREADY_EXISTS_RE = /already exists/i;

export function isWebviewAlreadyExistsError(err: unknown): boolean {
  return WEBVIEW_ALREADY_EXISTS_RE.test(parseAppError(err).message);
}

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
    if (!isWebviewAlreadyExistsError(err)) {
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
