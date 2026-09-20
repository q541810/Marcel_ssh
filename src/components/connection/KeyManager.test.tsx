// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoredKeyMeta } from '@/lib/types';

// 让 react act() 在 jsdom 下正常工作
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const {
  listKeys,
  importKeyFile,
  importKeyText,
  refreshKeyFromOrigin,
  keyOriginStatus,
  deleteKey,
  renameKey,
  dialogOpen,
} = vi.hoisted(() => ({
  listKeys: vi.fn(),
  importKeyFile: vi.fn(),
  importKeyText: vi.fn(),
  refreshKeyFromOrigin: vi.fn(),
  keyOriginStatus: vi.fn(),
  deleteKey: vi.fn(),
  renameKey: vi.fn(),
  dialogOpen: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  listKeys,
  importKeyFile,
  importKeyText,
  refreshKeyFromOrigin,
  keyOriginStatus,
  deleteKey,
  renameKey,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogOpen }));

// 保活封装在非 Android 环境整体 no-op；这里直接透传，避免拖进移动端桥
vi.mock('@/mobile/mobileBridge', () => ({
  withForegroundKeepAlive: (_keep: boolean, action: () => unknown) => action(),
}));

import KeyManager from './KeyManager';

function keyMeta(over: Partial<StoredKeyMeta> = {}): StoredKeyMeta {
  return {
    id: 'k1',
    name: '公司跳板机',
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:AbCdEfGhIjKlMnOp',
    encrypted: false,
    createdAt: '2026-09-20T00:00:00Z',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
const onSelect = vi.fn();

async function render(props: Partial<Parameters<typeof KeyManager>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <KeyManager selectedId={undefined} onSelect={onSelect} {...props} />,
    );
  });
}

function text(): string {
  return container.textContent ?? '';
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`找不到按钮：${label}\n当前文本：${text()}`);
  return found as HTMLButtonElement;
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keyAuthError(code: string, message: string) {
  return { kind: 'KeyAuth', message, data: { code } };
}

beforeEach(() => {
  vi.clearAllMocks();
  listKeys.mockResolvedValue([]);
  keyOriginStatus.mockResolvedValue(null);
  dialogOpen.mockResolvedValue(null);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('KeyManager 的导入与选择', () => {
  it('列出已导入的私钥，给出算法、指纹与"带密码"标记', async () => {
    listKeys.mockResolvedValue([
      keyMeta({ encrypted: true }),
      keyMeta({ id: 'k2', name: '个人钥匙', algorithm: 'ssh-rsa' }),
    ]);
    await render();

    expect(text()).toContain('公司跳板机');
    expect(text()).toContain('Ed25519');
    expect(text()).toContain('SHA256:AbCdEfGhIj'); // 截断后的指纹
    expect(text()).toContain('带密码');
    expect(text()).toContain('个人钥匙');
    expect(text()).toContain('RSA');
  });

  it('点一行就选中它；再点一次取消选择', async () => {
    listKeys.mockResolvedValue([keyMeta()]);
    await render();

    await click(button('公司跳板机'));
    expect(onSelect).toHaveBeenLastCalledWith('k1');
  });

  it('没有任何私钥时明确说"还没有导入"，不留白', async () => {
    await render();
    expect(text()).toContain('还没有导入任何私钥');
  });

  it('选择文件后立刻导入并选中它', async () => {
    dialogOpen.mockResolvedValue('/home/me/.ssh/id_ed25519');
    importKeyFile.mockResolvedValue(keyMeta({ id: 'new-1' }));
    listKeys.mockResolvedValueOnce([]).mockResolvedValue([keyMeta({ id: 'new-1' })]);
    await render();

    await click(button('选择密钥文件…'));

    expect(importKeyFile).toHaveBeenCalledWith(
      '/home/me/.ssh/id_ed25519',
      undefined,
      undefined,
    );
    expect(onSelect).toHaveBeenCalledWith('new-1');
  });

  it('用户取消选择文件时什么都不做', async () => {
    dialogOpen.mockResolvedValue(null);
    await render();

    await click(button('选择密钥文件…'));
    expect(importKeyFile).not.toHaveBeenCalled();
  });
});

describe('加密私钥：当场问密码，而不是事后连一次失败', () => {
  it('导入带密码的私钥时弹出密码输入，而不是丢一个错', async () => {
    dialogOpen.mockResolvedValue('/tmp/id_rsa');
    importKeyFile.mockRejectedValueOnce(
      keyAuthError('needs_passphrase', '此私钥已加密，请输入私钥密码'),
    );
    await render();

    await click(button('选择密钥文件…'));

    expect(text()).toContain('此私钥已加密，请输入私钥密码');
    // 关键：不能同时把"错误"也摆出来，那会让用户以为失败了
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
  });

  it('填上密码后带着同一个来源重试，成功后选中', async () => {
    dialogOpen.mockResolvedValue('/tmp/id_rsa');
    importKeyFile
      .mockRejectedValueOnce(keyAuthError('needs_passphrase', '此私钥已加密'))
      .mockResolvedValueOnce(keyMeta({ id: 'enc-1', encrypted: true }));
    listKeys.mockResolvedValue([keyMeta({ id: 'enc-1', encrypted: true })]);
    await render();

    await click(button('选择密钥文件…'));

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 's3cret');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('继续导入'));

    expect(importKeyFile).toHaveBeenLastCalledWith('/tmp/id_rsa', undefined, 's3cret');
    expect(onSelect).toHaveBeenCalledWith('enc-1');
  });

  it('密码不对时说清是密码不对，而不是换个含糊的报错', async () => {
    dialogOpen.mockResolvedValue('/tmp/id_rsa');
    importKeyFile.mockRejectedValueOnce(
      keyAuthError('bad_passphrase', '私钥密码不正确'),
    );
    await render();

    await click(button('选择密钥文件…'));
    expect(text()).toContain('密码不对');
    // 仍然要能继续输，而不是把入口收掉
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
  });

  it('格式不支持这类原因不追问密码，直接说清', async () => {
    dialogOpen.mockResolvedValue('/tmp/not-a-key');
    importKeyFile.mockRejectedValueOnce(
      keyAuthError('unsupported_key', '这个文件不是可识别的私钥。'),
    );
    await render();

    await click(button('选择密钥文件…'));

    expect(text()).toContain('这个文件不是可识别的私钥');
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('文件不存在也不追问密码（旧行为正是在这里问密码）', async () => {
    dialogOpen.mockResolvedValue('/tmp/gone');
    importKeyFile.mockRejectedValueOnce(
      keyAuthError('key_not_found', '私钥文件不存在：/tmp/gone'),
    );
    await render();

    await click(button('选择密钥文件…'));

    expect(text()).toContain('私钥文件不存在');
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('粘贴私钥内容', () => {
  it('粘贴正文后导入并选中', async () => {
    importKeyText.mockResolvedValue(keyMeta({ id: 'paste-1', name: '粘贴的' }));
    listKeys.mockResolvedValue([keyMeta({ id: 'paste-1', name: '粘贴的' })]);
    await render();

    await click(button('粘贴私钥内容…'));
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('导入'));

    expect(importKeyText).toHaveBeenCalledWith(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc',
      undefined,
      undefined,
    );
    expect(onSelect).toHaveBeenCalledWith('paste-1');
  });

  it('正文为空时导入按钮不可点', async () => {
    await render();
    await click(button('粘贴私钥内容…'));
    expect(button('导入').disabled).toBe(true);
  });
});

describe('删除与占用提示', () => {
  it('删除要二次确认，并说清有几条连接在用', async () => {
    listKeys.mockResolvedValue([keyMeta()]);
    await render({ usageOf: () => 2 });

    expect(text()).toContain('2 条连接在用');
    await click(button('删除'));
    expect(text()).toContain('删除这把私钥？');
    expect(text()).toContain('有 2 条连接正在用它');
    expect(deleteKey).not.toHaveBeenCalled();

    await click(button('确认删除'));
    expect(deleteKey).toHaveBeenCalledWith('k1');
  });

  it('没人用时就说没人用，不夸大后果', async () => {
    listKeys.mockResolvedValue([keyMeta()]);
    await render({ usageOf: () => 0 });

    await click(button('删除'));
    expect(text()).toContain('没有连接在用它');
  });
});

describe('原文件变了的提醒', () => {
  it('来源换成另一把钥匙时提示可以就地更新（原地换，连接不用改）', async () => {
    listKeys.mockResolvedValue([keyMeta({ originPath: '/home/me/.ssh/id_ed25519' })]);
    keyOriginStatus.mockResolvedValue({
      originPath: '/home/me/.ssh/id_ed25519',
      missing: false,
      changed: true,
    });
    refreshKeyFromOrigin.mockResolvedValue(keyMeta());
    await render();

    expect(text()).toContain('原文件已经是另一把钥匙了');
    await click(button('用原文件更新'));

    expect(refreshKeyFromOrigin).toHaveBeenCalledWith('k1', undefined);
    // 原地更新不动用户在表单里的选择
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('来源文件没了只说一句不影响使用，不催用户做任何事', async () => {
    listKeys.mockResolvedValue([keyMeta({ originPath: '/home/me/.ssh/gone' })]);
    keyOriginStatus.mockResolvedValue({
      originPath: '/home/me/.ssh/gone',
      missing: true,
      changed: false,
    });
    await render();

    expect(text()).toContain('已不在，不影响使用');
    expect(text()).not.toContain('用原文件更新');
  });

  it('没有来源的条目（粘贴导入的）不显示这一行', async () => {
    listKeys.mockResolvedValue([keyMeta({ name: '粘贴的' })]);
    await render();

    expect(keyOriginStatus).not.toHaveBeenCalled();
    expect(text()).not.toContain('已经是另一把钥匙');
    expect(text()).not.toContain('用原文件更新');
  });
});
