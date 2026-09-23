import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  pluginWebviewCreate: vi.fn(),
  pluginWebviewSetBounds: vi.fn(),
  pluginWebviewClose: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  pluginWebviewCreate: mocks.pluginWebviewCreate,
  pluginWebviewSetBounds: mocks.pluginWebviewSetBounds,
  pluginWebviewClose: mocks.pluginWebviewClose,
}));

import { acquire, destroy } from './pluginWebviewPool';

/** 后端 `plugin_webview_create` 对"label 已存在"的唯一裸字符串形态（Tauri 原话）。 */
function tauriAlreadyExists(label: string) {
  return `a webview with label \`${label}\` already exists`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pluginWebviewCreate.mockResolvedValue(undefined);
  mocks.pluginWebviewSetBounds.mockResolvedValue(undefined);
  mocks.pluginWebviewClose.mockResolvedValue(undefined);
});

/**
 * `acquire` 的「label 已存在 → 视为成功」恢复分支。
 *
 * 这条分支以前写成 `String(err).includes('already exists')`：后端一旦按项目惯例把命令
 * 改成结构化 `AppError`，`String(err)` 就是 "[object Object]"，条件永不成立——本该恢复的
 * 竞态（同一 label 被并发创建）会抛错，插槽显示"插件加载失败"。所以两种错误形态都得认：
 * 裸字符串（现在的 `Result<(), String>`）与 `{kind, message}`（结构化）。
 */
describe('pluginWebviewPool.acquire：WebView 已存在视为成功', () => {
  it('结构化错误里的原话也能判别出来（String(err) 会退化成 [object Object]）', async () => {
    const label = 'plugin-p1-view-structured';
    mocks.pluginWebviewCreate.mockRejectedValueOnce({
      kind: 'Other',
      message: tauriAlreadyExists(label),
    });

    await expect(
      acquire(label, 'p1', 'index.html', 1, 2, 300, 200),
    ).resolves.toBeUndefined();
    expect(mocks.pluginWebviewSetBounds).toHaveBeenCalledWith(
      label,
      1,
      2,
      300,
      200,
    );
    await destroy(label);
  });

  it('裸字符串错误（当前后端形态）照旧认得', async () => {
    const label = 'plugin-p1-view-string';
    mocks.pluginWebviewCreate.mockRejectedValueOnce(tauriAlreadyExists(label));

    await expect(
      acquire(label, 'p1', 'index.html', 0, 0, 100, 100),
    ).resolves.toBeUndefined();
    await destroy(label);
  });

  it('别的原因（插件被禁用等）照旧抛出来，不当成"已存在"', async () => {
    mocks.pluginWebviewCreate.mockRejectedValueOnce({
      kind: 'Other',
      message: 'plugin disabled: p1',
    });

    await expect(
      acquire('plugin-p1-view-denied', 'p1', 'index.html', 0, 0, 100, 100),
    ).rejects.toMatchObject({ message: 'plugin disabled: p1' });
  });
});
