// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SavedConnection } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

import ConnectionForm from './ConnectionForm';

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
const onSave = vi.fn();
const onCancel = vi.fn();
const onSecretsSaveError = vi.fn();

async function render(connection: SavedConnection = PRIVATE_KEY_CONN) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ConnectionForm
        connection={connection}
        onSave={onSave}
        onCancel={onCancel}
        onSecretsSaveError={onSecretsSaveError}
      />,
    );
  });
}

/** 按 label 文案找输入框（桌面 Input 把 label 与 input 放在同一个包裹元素里）。 */
function inputByLabel(text: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((l) =>
    (l.textContent ?? '').includes(text),
  );
  const input = label?.parentElement?.querySelector('input');
  if (!input) throw new Error(`找不到「${text}」输入框`);
  return input as HTMLInputElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) =>
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
});

/**
 * 私钥连接的「登录密码」字段。
 *
 * 它存在的唯一理由是 agent 执行 sudo 时要把它自动填给远端（bash 工具的 sudo
 * 改写读的是密钥链里 account = 连接 id 那条）。所以这一组盯死一件事：**写对账号**。
 * 密钥密码走 `pk:{id}`，登录密码走 `{id}`，两者串了会静默失效——sudo 填不上、
 * 或者连接拿密钥密码去当登录密码——而且完全没有报错提示。
 */
describe('私钥连接的登录密码', () => {
  it('私钥认证下提供登录密码字段，并说清它不是用来登录的', async () => {
    await render();
    const input = inputByLabel('登录密码');
    expect(input).toBeTruthy();
    expect(container.textContent).toContain('用不到这个密码');
  });

  it('填写后写进密码账号（savePassword），不是密钥密码账号', async () => {
    await render();
    await type(inputByLabel('登录密码'), 'sudo-pw');
    await act(async () => buttonByText('保存').click());

    expect(savePassword).toHaveBeenCalledWith('c1', 'sudo-pw');
    expect(savePassphrase).not.toHaveBeenCalled();
  });

  it('密钥密码仍然写进密钥密码账号（savePassphrase），两者互不串台', async () => {
    await render();
    await type(inputByLabel('密钥密码'), 'key-pass');
    await type(inputByLabel('登录密码'), 'sudo-pw');
    await act(async () => buttonByText('保存').click());

    expect(savePassphrase).toHaveBeenCalledWith('c1', 'key-pass');
    expect(savePassword).toHaveBeenCalledWith('c1', 'sudo-pw');
  });

  it('留空时什么都不写（不能把已保存的那份悄悄清掉）', async () => {
    await render();
    await act(async () => buttonByText('保存').click());

    expect(savePassword).not.toHaveBeenCalled();
    expect(savePassphrase).not.toHaveBeenCalled();
  });

  it('已保存时显示「已保存 / 修改 / 清除」，清除走 deletePassword', async () => {
    hasPassword.mockResolvedValue(true);
    await render();

    expect(container.textContent).toContain('登录密码：已保存');
    await act(async () => buttonByText('清除').click());

    expect(deletePassword).toHaveBeenCalledWith('c1');
    expect(deletePassphrase).not.toHaveBeenCalled();
  });

  it('密码认证下不出现这个字段（那是登录密码本身，另有一套）', async () => {
    await render({ ...PRIVATE_KEY_CONN, authMethod: 'Password', keyPath: undefined });
    const labels = Array.from(container.querySelectorAll('label')).map((l) => l.textContent ?? '');
    expect(labels.some((l) => l.includes('登录密码'))).toBe(false);
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
 * 密码认证下的「清除」。
 *
 * 密钥链里 account = 连接 id 的那条，在密码认证下就是登录密码。以前桌面只有私钥
 * 分支给它配了清除入口，密码认证分支既不写也不删 —— 于是 PasswordPrompt 里那句
 * 「要清掉已保存的凭证，用连接设置里的『清除』」在桌面密码认证场景指向一个不存在
 * 的控件（移动端两个分支都有）。这一组钉住补上的入口，别让它再掉。
 */
describe('密码认证：已保存密码的清除入口', () => {
  it('已保存时显示「已保存 / 修改 / 清除」，清除走 deletePassword', async () => {
    hasPassword.mockResolvedValue(true);
    await render(PASSWORD_CONN);

    expect(container.textContent).toContain('密码：已保存');
    await act(async () => buttonByText('清除').click());

    expect(deletePassword).toHaveBeenCalledWith('c1');
    expect(deletePassphrase).not.toHaveBeenCalled();
  });

  it('未保存时不给「清除」，但留着「重设密码」', async () => {
    hasPassword.mockResolvedValue(false);
    await render(PASSWORD_CONN);

    expect(container.textContent).not.toContain('密码：已保存');
    expect(buttonByText('重设密码')).toBeTruthy();
    expect(() => buttonByText('清除')).toThrow();
  });

  it('清除后那一行消失，且保存不会把密钥链里的密码写回来', async () => {
    hasPassword.mockResolvedValue(true);
    await render(PASSWORD_CONN);

    await act(async () => buttonByText('清除').click());
    expect(container.textContent).not.toContain('密码：已保存');

    await act(async () => buttonByText('保存').click());
    expect(savePassword).not.toHaveBeenCalled();
  });
});

/** 提交按钮（PasswordPrompt 里显式写了 type="submit"；表单自己的 Button 没有该属性）。 */
function submitButton(): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('type') === 'submit',
  );
  if (!el) throw new Error('找不到提交按钮');
  return el as HTMLButtonElement;
}

/**
 * 凭证没写进密钥链时必须出声。
 *
 * 表单保存后**立刻关闭**，自己那条提示活不到用户看见，所以失败经
 * `onSecretsSaveError` 说给外面的既有报错面（连接列表那条红条）。以前这里只
 * `console.warn`：用户看到的是"保存成功"的表象，实际什么都没存上，下次连接又得
 * 重新输一遍，而他会以为自己早就存过了。
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
    expect(onSecretsSaveError).toHaveBeenCalledTimes(1);
    const msg = onSecretsSaveError.mock.calls[0][0] as string;
    expect(msg).toContain('access denied');
    expect(msg).toContain('下次连接');
  });

  it('一切正常时不打扰（不报空警告）', async () => {
    await render();
    await type(inputByLabel('密钥密码'), 'key-pass');
    await act(async () => buttonByText('保存').click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSecretsSaveError).not.toHaveBeenCalled();
  });

  it('「重设密码」失败时浮层留原地、把原因写进说明，而不是关掉假装成功', async () => {
    hasPassword.mockResolvedValue(false);
    savePassword.mockRejectedValueOnce({
      kind: 'Config',
      message: '密钥链初始化失败',
    });
    await render(PASSWORD_CONN);

    await act(async () => buttonByText('重设密码').click());
    const input = document.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error('找不到密码输入框');
    await type(input, 'new-pw');
    await act(async () => submitButton().click());

    // 浮层还在，原因写在说明里，用户输入也还在（可直接重试）
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
      'new-pw',
    );
    expect(document.body.textContent).toContain('密钥链初始化失败');
  });

  it('「重设密码」成功后表单转为「密码：已保存」，不留下失败说明', async () => {
    hasPassword.mockResolvedValue(false);
    await render(PASSWORD_CONN);

    await act(async () => buttonByText('重设密码').click());
    const input = document.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error('找不到密码输入框');
    await type(input, 'new-pw');
    await act(async () => submitButton().click());

    expect(savePassword).toHaveBeenCalledWith('c1', 'new-pw');
    expect(container.textContent).toContain('密码：已保存');
    expect(document.body.textContent).not.toContain('上次没能保存');
  });
});
