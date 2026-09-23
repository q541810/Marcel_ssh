// @vitest-environment jsdom
/**
 * 主机密钥警告的系统通知标题必须走隐私模式口径。
 *
 * 系统通知是最外向的展示面——它会留在通知中心、锁屏也能看到，比终端里的一行字
 * 更容易被旁人瞟到。以前标题里裸插 `${host}:${port}`，隐私模式形同虚设。
 *
 * 去重 key 仍用真实值（那是"这条警告发过没有"的判据，与显示无关），这里一并钉住：
 * 隐私模式只能改显示，不能改行为。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  handler: null as ((payload: unknown) => void) | null,
  privacy: false,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: mocks.sendNotification,
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
}));

vi.mock('@/hooks/useTauriEvent', () => ({
  useTauriEvent: (
    _name: string,
    handler: (payload: unknown) => void,
  ): void => {
    mocks.handler = handler;
  },
}));

vi.mock('@/hooks/usePrivacyMode', () => ({
  usePrivacyMode: () => mocks.privacy,
}));

import HostKeyWarningToast from './HostKeyWarningToast';

const PAYLOAD = {
  host: '10.0.0.1',
  port: 22,
  reason: 'permission denied',
  message: '主机密钥未能持久化，本次连接安全但不保证未来能检测密钥变更，请检查配置目录可写性',
};

let container: HTMLDivElement;
let root: Root;

/** 挂载（`useTauriEvent` 的 mock 每次渲染都记下最新回调，与真实 hook 的 ref 行为一致）。 */
function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<HostKeyWarningToast />);
  });
}

/** 等动态 import + 权限检查跑完（全是微任务）。 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 触发一次 hostKeyWarning 事件（组件把回调交给了被 mock 的 useTauriEvent）。 */
async function fire(payload: unknown) {
  if (!mocks.handler) throw new Error('组件没有订阅 hostKeyWarning');
  await act(async () => {
    mocks.handler?.(payload);
  });
  await flush();
}

function titleOfFirstNotification(): string {
  const call = mocks.sendNotification.mock.calls[0]?.[0] as
    | { title: string; body: string }
    | undefined;
  if (!call) throw new Error('没有发出通知');
  return call.title;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.privacy = false;
  mocks.handler = null;
  mocks.isPermissionGranted.mockResolvedValue(true);
  mocks.requestPermission.mockResolvedValue('granted');
  mocks.sendNotification.mockReturnValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

describe('主机密钥警告通知', () => {
  it('非隐私模式下照实写 host:port', async () => {
    render();

    await fire(PAYLOAD);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(titleOfFirstNotification()).toContain('10.0.0.1:22');
  });

  it('隐私模式下标题不出现真实主机与端口', async () => {
    mocks.privacy = true;
    render();

    await fire(PAYLOAD);

    const title = titleOfFirstNotification();
    expect(title).toContain('***:****');
    expect(title).not.toContain('10.0.0.1');
    expect(title).not.toContain(':22');
    // 正文是后端给的固定说明，不含主机信息，照原样带走
    expect(mocks.sendNotification.mock.calls[0][0].body).toBe(PAYLOAD.message);
  });

  it('同一条警告（同 host:port:message）只发一次；隐私模式不影响这条去重', async () => {
    mocks.privacy = true;
    render();

    await fire(PAYLOAD);
    await fire(PAYLOAD);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });
});
