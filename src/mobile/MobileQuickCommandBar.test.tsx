// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { sshSendInput } = vi.hoisted(() => ({ sshSendInput: vi.fn() }));

vi.mock('@/lib/tauri', () => ({ sshSendInput }));

import MobileQuickCommandBar from './MobileQuickCommandBar';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import type { MobileQuickCommand } from './quickCommands';

const CMD: MobileQuickCommand = {
  id: 'q1',
  label: '重启服务',
  lines: ['systemctl restart nginx'],
  intervalMs: 0,
  insertOnly: false,
};

let container: HTMLDivElement;
let root: Root;
const onError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // 真 store：execute 落完 store 错误后原样 rethrow，正是要验的那条路径
  useQuickCommandStore.setState({
    commands: [],
    error: null,
    executingId: null,
    lastSessionKey: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderBar() {
  await act(async () => {
    root.render(
      <MobileQuickCommandBar commands={[CMD]} sessionId="s1" onError={onError} />,
    );
  });
}

async function tapCommand() {
  const chip = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('重启服务'),
  );
  if (!chip) throw new Error('找不到快捷命令按钮');
  await act(async () => {
    chip.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * 快捷命令执行失败时的提示文案。
 *
 * `quickCommandStore.execute` 会先把错误经 getErrorMessage 落进 store，然后把**原始
 * 错误原样 rethrow** —— Tauri 命令失败时抛的是结构化对象 `{ kind, message, data? }`，
 * 不是 Error。这里原来写的是 `err instanceof Error ? err.message : String(err)`，
 * 于是 onError（MobileTerminalHost 的 setIoError，会显示给用户）收到 "[object Object]"。
 * 桌面同一功能（QuickCommandPanel）一直走 getErrorMessage，这条是双端对齐。
 */
describe('快捷命令失败时的错误文案', () => {
  it('结构化 AppError 取 message，不是 [object Object]', async () => {
    sshSendInput.mockRejectedValue({ kind: 'Other', message: '会话已断开' });
    await renderBar();

    await tapCommand();

    expect(onError).toHaveBeenCalledWith('会话已断开');
  });

  it('普通 Error 仍取 message', async () => {
    sshSendInput.mockRejectedValue(new Error('写入失败'));
    await renderBar();

    await tapCommand();

    expect(onError).toHaveBeenCalledWith('写入失败');
  });

  it('成功时不报错', async () => {
    sshSendInput.mockResolvedValue(undefined);
    await renderBar();

    await tapCommand();

    expect(onError).not.toHaveBeenCalled();
  });
});
