// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SavedConnection } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不实现 ResizeObserver，MobileSheet 用它测拖拽高度
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const {
  listKeys,
  hasPassphrase,
  hasPassword,
  savePassphrase,
  savePassword,
  deletePassphrase,
  deletePassword,
} = vi.hoisted(() => ({
  listKeys: vi.fn(),
  hasPassphrase: vi.fn(),
  hasPassword: vi.fn(),
  savePassphrase: vi.fn(),
  savePassword: vi.fn(),
  deletePassphrase: vi.fn(),
  deletePassword: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  listKeys,
  hasPassphrase,
  hasPassword,
  savePassphrase,
  savePassword,
  deletePassphrase,
  deletePassword,
  hasJumpPassword: vi.fn().mockResolvedValue(false),
  hasJumpPassphrase: vi.fn().mockResolvedValue(false),
  saveJumpPassword: vi.fn(),
  saveJumpPassphrase: vi.fn(),
  deleteJumpPassword: vi.fn().mockResolvedValue(undefined),
  deleteJumpPassphrase: vi.fn().mockResolvedValue(undefined),
}));

import MobileConnectionForm from './MobileConnectionForm';

const PRIVATE_KEY_CONN: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'PrivateKey',
  keyPath: '~/.ssh/id_ed25519',
};

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn().mockResolvedValue(undefined);
const onCancel = vi.fn();
const onSecretSaveError = vi.fn();

async function render(connection: SavedConnection = PRIVATE_KEY_CONN) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MobileConnectionForm
        open
        connection={connection}
        onSave={onSave}
        onCancel={onCancel}
        onSecretSaveError={onSecretSaveError}
      />,
    );
  });
}

/** 移动端 Field 把 label 与控件放在同一个包裹元素里，按文案就能定位。 */
function inputByLabel(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('label')).find((l) =>
    (l.textContent ?? '').includes(text),
  );
  const input = label?.parentElement?.querySelector('input');
  if (!input) throw new Error(`找不到「${text}」输入框`);
  return input as HTMLInputElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`找不到按钮「${text}」`);
  return found as HTMLButtonElement;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 等一次异步的密钥链检查跑完（setTimeout(0) 让 microtask 队列先排空）。 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * 切换「认证方式」下拉。
 * jsdom 里要拿原型上的原生 setter 绕开 React 的 value tracker，再派发 change。
 */
async function selectAuth(value: 'Password' | 'PrivateKey') {
  const select = Array.from(document.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.value === 'PrivateKey'),
  );
  if (!select) throw new Error('找不到认证方式下拉');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  listKeys.mockResolvedValue([]);
  hasPassphrase.mockResolvedValue(false);
  hasPassword.mockResolvedValue(false);
  savePassphrase.mockResolvedValue(undefined);
  savePassword.mockResolvedValue(undefined);
  deletePassphrase.mockResolvedValue(undefined);
  deletePassword.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  // MobileSheet 用 createPortal 挂到 body，卸载后清掉残留容器
  document.body.innerHTML = '';
});

/**
 * 与桌面 ConnectionForm 对称：私钥连接的「登录密码」必须写进密码账号（`{id}`），
 * 不能串到密钥密码账号（`pk:{id}`）。双端各有一份表单实现，所以两边都要钉。
 */
describe('移动端：私钥连接的登录密码', () => {
  it('提供该字段，并说清它不是用来登录的', async () => {
    await render();
    expect(inputByLabel('登录密码')).toBeTruthy();
    expect(document.body.textContent).toContain('用不到它');
  });

  it('填写后写进密码账号，不是密钥密码账号', async () => {
    await render();
    await type(inputByLabel('登录密码'), 'sudo-pw');
    await act(async () => buttonByText('保存').click());

    expect(savePassword).toHaveBeenCalledWith('c1', 'sudo-pw');
    expect(savePassphrase).not.toHaveBeenCalled();
  });

  it('密钥密码与登录密码各写各的账号', async () => {
    await render();
    await type(inputByLabel('密钥密码'), 'key-pass');
    await type(inputByLabel('登录密码'), 'sudo-pw');
    await act(async () => buttonByText('保存').click());

    expect(savePassphrase).toHaveBeenCalledWith('c1', 'key-pass');
    expect(savePassword).toHaveBeenCalledWith('c1', 'sudo-pw');
  });

  it('留空时什么都不写', async () => {
    await render();
    await act(async () => buttonByText('保存').click());

    expect(savePassword).not.toHaveBeenCalled();
    expect(savePassphrase).not.toHaveBeenCalled();
  });

  it('已保存时可清除，清除走 deletePassword', async () => {
    hasPassword.mockResolvedValue(true);
    await render();

    expect(document.body.textContent).toContain('已保存在本设备');
    await act(async () => buttonByText('清除').click());

    expect(deletePassword).toHaveBeenCalledWith('c1');
    expect(deletePassphrase).not.toHaveBeenCalled();
  });
});

const PASSWORD_CONN: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'Password',
};

/**
 * 「已保存 / 清除」那一行必须三者同源：可见性（hasSecret）、标签、以及「清除」
 * 删的账号，都跟着**当前选择的认证方式**走。
 *
 * 曾经的 bug：hasSecret 只在表单打开时按保存时的认证方式取一次，切换认证方式时
 * 只清 secret/secretDirty，于是密钥密码已存而密码没存的私钥连接改成密码认证后，
 * 那一行还在、自称「密码 / 已保存在本设备」，点清除却删掉 {id}（那条是 sudo 登录
 * 密码），而它看起来该清的 pk:{id} 原封不动 —— 静默的数据丢失。
 */
describe('切换认证方式后的「已保存 / 清除」', () => {
  it('密钥密码已存、密码未存：改成密码认证后不再声称密码已保存', async () => {
    hasPassphrase.mockResolvedValue(true);
    hasPassword.mockResolvedValue(false);
    await render();

    expect(document.body.textContent).toContain('已保存在本设备');

    await selectAuth('Password');

    // 密码账号没东西可清 → 不给「清除」，只给一个空的密码输入
    expect(() => buttonByText('清除')).toThrow();
    expect(document.body.textContent).not.toContain('已保存在本设备');
    expect(inputByLabel('密码')).toBeTruthy();
  });

  it('密码已存、密钥密码未存：改成私钥认证后不再声称密钥密码已保存', async () => {
    hasPassword.mockResolvedValue(true);
    hasPassphrase.mockResolvedValue(false);
    await render(PASSWORD_CONN);

    expect(document.body.textContent).toContain('已保存在本设备');

    await selectAuth('PrivateKey');

    // 「已保存」那种行的 Field label 只有「密钥密码」，还给输入框的那种带（可选）
    const labels = Array.from(document.querySelectorAll('label')).map(
      (l) => l.textContent ?? '',
    );
    expect(labels).toContain('密钥密码（可选）');
    expect(labels).not.toContain('密钥密码');
  });

  it('两种凭证都存了：改成密码认证后「清除」删的是密码账号', async () => {
    hasPassphrase.mockResolvedValue(true);
    hasPassword.mockResolvedValue(true);
    await render();

    await selectAuth('Password');

    // 这个「已保存在本设备」确实是密码账号的（重取过），标签也是「密码」
    expect(document.body.textContent).toContain('已保存在本设备');
    await act(async () => buttonByText('清除').click());

    expect(deletePassword).toHaveBeenCalledWith('c1');
    expect(deletePassphrase).not.toHaveBeenCalled();
  });
});

/**
 * 凭证没写进密钥链时必须出声（与桌面 ConnectionForm 对称）。
 *
 * 浮层保存后立刻关闭，自己那条提示活不到用户看见，所以失败经 `onSecretSaveError`
 * 说给外面的既有报错面（连接列表那条红条）。以前这里连 console 都不打，用户看到
 * 的是"保存成功"的表象，实际什么都没存上。
 *
 * 保存本身不拦——密钥链不可用不该挡着存连接，这是既有的取舍。
 */
describe('凭证写入失败要说出来', () => {
  it('persistSecrets 失败仍保存连接，但把原因报到宿主', async () => {
    savePassphrase.mockRejectedValueOnce({
      kind: 'Config',
      message: '保存密码到密钥链失败：access denied',
    });
    await render();
    await type(inputByLabel('密钥密码'), 'key-pass');
    await act(async () => buttonByText('保存').click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSecretSaveError).toHaveBeenCalledTimes(1);
    const msg = onSecretSaveError.mock.calls[0][0] as string;
    expect(msg).toContain('access denied');
    expect(msg).toContain('下次连接');
  });

  it('一切正常时不打扰（不报空警告）', async () => {
    await render();
    await type(inputByLabel('密钥密码'), 'key-pass');
    await act(async () => buttonByText('保存').click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSecretSaveError).not.toHaveBeenCalled();
  });
});
