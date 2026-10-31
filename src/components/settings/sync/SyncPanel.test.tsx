// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as tauri from '@/lib/tauri';
import { useSyncStore } from '@/stores/syncStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { SearchRegistryProvider } from '@/components/settings/helpers';
import type { SyncDevice, SyncHistoryEntry, SyncStatus } from '@/lib/types';
import { SyncPanel } from './SyncPanel';
import type { SyncVariant } from './syncUi';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// MobileSheet 用它在键盘弹起时保持输入框可见；jsdom 不实现
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// 桌面 Select 展开时把当前项滚进视野；jsdom 没有 scrollIntoView
Element.prototype.scrollIntoView = () => {};

vi.mock('@/lib/tauri', () => ({
  syncGetStatus: vi.fn(),
  syncNow: vi.fn(),
  syncTestStorage: vi.fn(),
  syncCreate: vi.fn(),
  syncJoin: vi.fn(),
  syncJoinManual: vi.fn(),
  syncGetSyncCode: vi.fn(),
  syncGetRecoveryKey: vi.fn(),
  syncSetDeviceName: vi.fn(),
  syncListDevices: vi.fn(),
  syncListHistory: vi.fn(),
  syncUndo: vi.fn(),
  syncConfirmHeld: vi.fn(),
  syncDisable: vi.fn(),
  getConnections: vi.fn(),
}));

const copy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/copyText', () => ({ copyText: copy }));

const KEY = 'abcd2345efgh6789jkmnpqrstuvwxyz2';
const KEY_GROUPED = 'abcd-2345-efgh-6789-jkmn-pqrs-tuvw-xyz2';

function status(partial: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: true,
    state: 'idle',
    lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastError: null,
    pendingCount: 0,
    deviceId: 'dev-self',
    deviceName: '书房电脑',
    storage: { kind: 'webDav', url: 'https://dav.jianguoyun.com/dav/', username: 'me@x.com', root: 'marcel-sync' },
    held: null,
    tiers: { config: true, conversation: false, secret: false },
    streams: [],
    ...partial,
  };
}

const OFF = status({ enabled: false, state: 'off', lastSyncAt: null, storage: null, deviceId: null, deviceName: null });

const DEVICES: SyncDevice[] = [
  { id: 'dev-self', name: '书房电脑', platform: 'desktop', appVersion: '1.12.0', lastSeenAt: new Date().toISOString(), isSelf: true, tiers: { config: true, conversation: false, secret: false } },
  { id: 'dev-phone', name: '我的手机', platform: 'android', appVersion: '1.12.0', lastSeenAt: new Date(Date.now() - 3600_000).toISOString(), isSelf: false, tiers: { config: true, conversation: false, secret: false } },
];

const HISTORY: SyncHistoryEntry[] = [
  {
    id: 'h1',
    at: new Date(Date.now() - 600_000).toISOString(),
    deviceName: '我的手机',
    source: 'settings',
    path: 'fontSize',
    oldValue: '14',
    newValue: '16',
    kind: 'change',
    undone: false,
  },
  {
    id: 'h2',
    at: new Date(Date.now() - 1_200_000).toISOString(),
    deviceName: '我的手机',
    source: 'knownHosts',
    path: 'entries/abc',
    oldValue: null,
    newValue: '另一台设备记录的 example.com 主机指纹与本机不同，没有应用',
    kind: 'warning',
    undone: false,
  },
];

let root: Root;
let container: HTMLDivElement;

function mount(variant: SyncVariant) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <SearchRegistryProvider>
        <SyncPanel variant={variant} />
      </SearchRegistryProvider>,
    );
  });
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'));
}

function findButton(text: string): HTMLButtonElement {
  const found = buttons().find((b) => (b.textContent ?? '').replace(/\s+/g, '').includes(text.replace(/\s+/g, '')));
  if (!found) throw new Error(`找不到按钮「${text}」。现有按钮：${buttons().map((b) => b.textContent).join(' | ')}`);
  return found;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function inputByLabel(label: string): HTMLInputElement {
  const labelEl = Array.from(document.body.querySelectorAll('label')).find((l) => l.textContent?.includes(label));
  const control =
    (labelEl?.htmlFor ? document.getElementById(labelEl.htmlFor) : null) ??
    labelEl?.parentElement?.querySelector('input,textarea');
  if (!control) throw new Error(`找不到输入框「${label}」`);
  return control as HTMLInputElement;
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  vi.mocked(tauri.syncGetStatus).mockReset().mockResolvedValue(OFF);
  vi.mocked(tauri.syncListDevices).mockReset().mockResolvedValue(DEVICES);
  vi.mocked(tauri.syncListHistory).mockReset().mockResolvedValue(HISTORY);
  vi.mocked(tauri.getConnections).mockReset().mockResolvedValue([
    { id: 'c1', name: '我的 VPS', host: 'vps.example.com', port: 22, username: 'root', authMethod: 'Password' },
    { id: 'c2', name: '家里 NAS', host: 'nas.local', port: 22, username: 'me', authMethod: 'PrivateKey' },
  ]);
  for (const fn of [
    tauri.syncNow,
    tauri.syncTestStorage,
    tauri.syncJoin,
    tauri.syncJoinManual,
    tauri.syncSetDeviceName,
    tauri.syncUndo,
    tauri.syncConfirmHeld,
    tauri.syncDisable,
  ]) {
    vi.mocked(fn).mockReset().mockResolvedValue(undefined);
  }
  vi.mocked(tauri.syncGetSyncCode).mockReset().mockResolvedValue('MSYNC1-' + 'Zm9v'.repeat(30));
  vi.mocked(tauri.syncGetRecoveryKey).mockReset().mockResolvedValue(KEY);
  vi.mocked(tauri.syncCreate).mockReset();
  copy.mockReset().mockResolvedValue(undefined);
  useSyncStore.setState({
    status: null,
    statusError: null,
    devices: [],
    history: [],
    devicesError: null,
    historyError: null,
    syncingNow: false,
  });
  useConnectionStore.setState({ connections: [], loaded: false });
});

afterEach(async () => {
  // 弹层退场 / 机密收起各有 ~400ms 的卸载兜底定时器，等它们走完再拆，免得在测试之外更新状态。
  await flush(450);
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe.each<SyncVariant>(['desktop', 'mobile'])('SyncPanel（%s）', (variant) => {
  it('读取状态失败：就地说明原因并给重试，不影响别处', async () => {
    vi.mocked(tauri.syncGetStatus).mockRejectedValueOnce({ kind: 'Other', message: '同步模块未就绪' });
    mount(variant);
    await flush();
    expect(bodyText()).toContain('读取同步状态失败：同步模块未就绪');
    await click(findButton('重试'));
    expect(tauri.syncGetStatus).toHaveBeenCalledTimes(2);
    expect(bodyText()).toContain('端到端加密'); // 重试成功后进入未开启形态
  });

  it('未开启：一句话说明 + 「开启同步」「加入已有同步」两个入口', async () => {
    mount(variant);
    await flush();
    expect(bodyText()).toContain('端到端加密');
    expect(bodyText()).toContain('存储方只看得到一堆看不懂的密文');
    expect(buttons().map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['开启同步', '加入已有同步']),
    );
  });

  describe('开启向导', () => {
    async function openCreate() {
      mount(variant);
      await flush();
      await click(findButton('开启同步'));
    }

    async function fillWebDav() {
      await type(inputByLabel('WebDAV 地址'), 'https://dav.jianguoyun.com/dav/');
      await type(inputByLabel('账号'), 'me@x.com');
      await type(inputByLabel('应用密码'), 'app-password');
    }

    it('先测试连接、通过后才能开启；坚果云给出针对性提示', async () => {
      await openCreate();
      expect(bodyText()).toContain('https://dav.jianguoyun.com/dav/'); // 占位 / 提示
      const submit = () => buttons().filter((b) => b.textContent === '开启同步').pop()!;
      expect(submit().disabled).toBe(true);

      await fillWebDav();
      expect(bodyText()).toContain('应用密码');
      expect(submit().disabled).toBe(true); // 还没测试

      await click(findButton('测试连接'));
      expect(tauri.syncTestStorage).toHaveBeenCalledWith(
        // 坚果云根目录不允许建文件夹，填它的地址时同步文件夹自动推到「我的坚果云/」下
        { kind: 'webDav', url: 'https://dav.jianguoyun.com/dav/', username: 'me@x.com', root: '我的坚果云/marcel-sync' },
        'app-password',
      );
      expect(bodyText()).toContain('连接正常');
      expect(submit().disabled).toBe(false);

      // 改了任何输入，测试结论作废
      await type(inputByLabel('账号'), 'other@x.com');
      expect(bodyText()).not.toContain('连接正常');
      expect(submit().disabled).toBe(true);
    });

    it('测试连接失败：展示后端给的原因，不放行', async () => {
      vi.mocked(tauri.syncTestStorage).mockRejectedValueOnce({ kind: 'Auth', message: '账号或密码不对' });
      await openCreate();
      await fillWebDav();
      await click(findButton('测试连接'));
      expect(bodyText()).toContain('账号或密码不对');
      const submit = buttons().filter((b) => b.textContent === '开启同步').pop()!;
      expect(submit.disabled).toBe(true);
    });

    it('创建成功后展示恢复密钥：勾选「已妥善保存」才能完成；中途状态翻成已开启也不丢密钥', async () => {
      // 创建成功的同时后端状态已变成"已开启"——面板分支会切换，向导必须原地保留
      vi.mocked(tauri.syncCreate).mockImplementation(async () => {
        vi.mocked(tauri.syncGetStatus).mockResolvedValue(status());
        return { recoveryKey: KEY, syncCode: 'MSYNC1-xyz' };
      });
      await openCreate();
      await fillWebDav();
      await click(findButton('测试连接'));
      await click(buttons().filter((b) => b.textContent === '开启同步').pop()!);

      expect(tauri.syncCreate).toHaveBeenCalledWith(
        { kind: 'webDav', url: 'https://dav.jianguoyun.com/dav/', username: 'me@x.com', root: '我的坚果云/marcel-sync' },
        'app-password',
      );
      // 面板已经切到"已开启"，恢复密钥依旧在屏幕上
      expect(useSyncStore.getState().status?.enabled).toBe(true);
      const keyBox = document.body.querySelector('[data-testid="recovery-key"]');
      expect(keyBox?.textContent).toBe(KEY_GROUPED.replace(/-/g, ''));
      expect(bodyText()).toContain('恢复密钥等同于钥匙');
      expect(bodyText()).toContain('随时在「设置 → 同步」里再次查看');

      const done = findButton('完成');
      expect(done.disabled).toBe(true);
      await click(findButton('复制恢复密钥'));
      expect(copy).toHaveBeenCalledWith(KEY_GROUPED);

      const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
      await click(checkbox);
      expect(findButton('完成').disabled).toBe(false);
      await click(findButton('完成'));
      await vi.waitFor(() => expect(document.body.querySelector('[data-testid="recovery-key"]')).toBeNull());
      expect(bodyText()).toContain('跨设备同步已开启');
    });

    it('创建失败：错误留在向导里，可以改了再试', async () => {
      vi.mocked(tauri.syncCreate).mockRejectedValueOnce({ kind: 'Other', message: '该位置已有同步数据，请用「加入」' });
      await openCreate();
      await fillWebDav();
      await click(findButton('测试连接'));
      await click(buttons().filter((b) => b.textContent === '开启同步').pop()!);
      expect(bodyText()).toContain('该位置已有同步数据');
      expect(document.body.querySelector('[data-testid="recovery-key"]')).toBeNull();
    });

    it('SFTP：从已保存的服务器里选；私钥登录的服务器提示加入新设备时的做法', async () => {
      await openCreate();
      await click(findButton('我的服务器'));
      expect(bodyText()).toContain('选择一台已保存的服务器');
      // 选择 NAS（私钥登录）
      const trigger = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label')?.includes('同步用的服务器'),
      )!;
      await click(trigger);
      const option = Array.from(document.body.querySelectorAll('[role="option"], [role="radio"]')).find((el) =>
        el.textContent?.includes('家里 NAS'),
      )!;
      // 桌面 Select 在 pointerdown 时选中，手机 MobileSelect 在 click 时选中
      await act(async () => {
        option.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        (option as HTMLElement).click();
      });
      await flush();
      expect(bodyText()).toContain('这台服务器用私钥登录');
    });
  });

  describe('加入向导', () => {
    async function openJoin() {
      mount(variant);
      await flush();
      await click(findButton('加入已有同步'));
    }

    it('同步码：粘贴后加入；说明合并规则「冲突以云端为准」', async () => {
      await openJoin();
      expect(bodyText()).toContain('冲突时以云端为准');
      const join = () => buttons().filter((b) => b.textContent === '加入').pop()!;
      expect(join().disabled).toBe(true);
      await type(inputByLabel('同步码'), '  MSYNC1-' + 'a'.repeat(60) + '\n');
      expect(join().disabled).toBe(false);
      await click(join());
      expect(tauri.syncJoin).toHaveBeenCalledWith('MSYNC1-' + 'a'.repeat(60));
      await vi.waitFor(() => expect(bodyText()).not.toContain('冲突时以云端为准'));
      expect(bodyText()).toContain('已加入同步');
    });

    it('同步码不对：后端的原因显示出来，向导不关', async () => {
      vi.mocked(tauri.syncJoin).mockRejectedValueOnce({ kind: 'Other', message: '恢复密钥不对' });
      await openJoin();
      await type(inputByLabel('同步码'), 'MSYNC1-' + 'a'.repeat(60));
      await click(buttons().filter((b) => b.textContent === '加入').pop()!);
      expect(bodyText()).toContain('恢复密钥不对');
      expect(bodyText()).toContain('冲突时以云端为准');
    });

    it('手动输入：存储 + 恢复密钥；恢复密钥忽略大小写和分隔符', async () => {
      await openJoin();
      await click(findButton('手动输入'));
      await type(inputByLabel('WebDAV 地址'), 'https://dav.example.com/');
      await type(inputByLabel('账号'), 'me');
      await type(inputByLabel('密码'), 'pw');
      const join = () => buttons().filter((b) => b.textContent === '加入').pop()!;
      expect(join().disabled).toBe(true);
      await type(inputByLabel('恢复密钥'), 'ABCD-2345 efgh-6789-JKMN-pqrs-tuvw-xyz2');
      expect(join().disabled).toBe(false);
      await click(join());
      expect(tauri.syncJoinManual).toHaveBeenCalledWith(
        { kind: 'webDav', url: 'https://dav.example.com/', username: 'me', root: 'marcel-sync' },
        'pw',
        KEY,
      );
    });
  });

  describe('已开启', () => {
    async function mountEnabled(s: SyncStatus = status()) {
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(s);
      mount(variant);
      await flush();
    }

    it('状态行、存放位置、同步范围（后两项灰显标「后续版本支持」）', async () => {
      await mountEnabled();
      const text = bodyText();
      expect(text).toContain('已同步 · 5 分钟前');
      expect(text).toContain('WebDAV · dav.jianguoyun.com · marcel-sync');
      expect(text).toContain('普通配置');
      expect(text).toContain('对话与记忆');
      expect(text).toContain('机密');
      expect((text.match(/后续版本支持/g) ?? []).length).toBe(2);
      // 普通配置开着且不可关
      const switches = Array.from(document.body.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
      expect(switches).toHaveLength(3);
      expect(switches[0].getAttribute('aria-checked')).toBe('true');
      expect(switches.every((s) => s.disabled)).toBe(true);
    });

    it('立即同步', async () => {
      await mountEnabled();
      await click(findButton('立即同步'));
      expect(tauri.syncNow).toHaveBeenCalledTimes(1);
    });

    it('出错：显示原因，按钮变成「重试」', async () => {
      await mountEnabled(status({ state: 'error', lastError: '连不上服务器' }));
      expect(bodyText()).toContain('同步出错');
      expect(bodyText()).toContain('连不上服务器');
      await click(findButton('重试'));
      expect(tauri.syncNow).toHaveBeenCalledTimes(1);
    });

    it('需要升级：说明原因与后果', async () => {
      await mountEnabled(status({ state: 'needsUpgrade' }));
      expect(bodyText()).toContain('需要升级到新版本');
      expect(bodyText()).toContain('升级应用后会自动继续同步');
    });

    it('等待确认的大量删除：醒目横幅，两个按钮分别放行 / 撤销', async () => {
      await mountEnabled(status({ state: 'needsConfirm', held: [{ source: 'connections', count: 6 }] }));
      expect(bodyText()).toContain('本机一次删除了 6 个连接，确认同步到其它设备？');
      await click(findButton('撤销删除'));
      expect(tauri.syncConfirmHeld).toHaveBeenLastCalledWith(false);
      await click(findButton('同步删除'));
      expect(tauri.syncConfirmHeld).toHaveBeenLastCalledWith(true);
    });

    it('添加设备：默认不取同步码；点显示才取，并提醒等同于钥匙；桌面有二维码、手机没有', async () => {
      await mountEnabled();
      expect(tauri.syncGetSyncCode).not.toHaveBeenCalled();
      expect(document.body.querySelector('[data-testid="sync-code"]')).toBeNull();

      await click(findButton('显示同步码'));
      expect(tauri.syncGetSyncCode).toHaveBeenCalledTimes(1);
      expect(document.body.querySelector('[data-testid="sync-code"]')?.textContent).toContain('MSYNC1-');
      expect(bodyText()).toContain('等同于钥匙本身');
      const qr = document.body.querySelector('svg[aria-label="同步码二维码"]');
      if (variant === 'desktop') expect(qr).not.toBeNull();
      else expect(qr).toBeNull();

      await click(findButton('复制同步码'));
      expect(copy).toHaveBeenCalledWith('MSYNC1-' + 'Zm9v'.repeat(30));
      await click(findButton('隐藏'));
      await vi.waitFor(() => expect(document.body.querySelector('[data-testid="sync-code"]')).toBeNull());
    });

    it('同步码取不到：就地给出原因', async () => {
      vi.mocked(tauri.syncGetSyncCode).mockRejectedValueOnce({ kind: 'Other', message: '密钥链不可用' });
      await mountEnabled();
      await click(findButton('显示同步码'));
      expect(bodyText()).toContain('密钥链不可用');
    });

    it('查看恢复密钥：4 个一组展示，带复制，并提醒别发给别人', async () => {
      await mountEnabled();
      await click(findButton('查看恢复密钥'));
      expect(document.body.querySelector('[data-testid="recovery-key"]')?.textContent).toBe(KEY_GROUPED.replace(/-/g, ''));
      expect(bodyText()).toContain('恢复密钥等同于钥匙');
      await click(findButton('复制恢复密钥'));
      expect(copy).toHaveBeenCalledWith(KEY_GROUPED);
    });

    it('本设备名称：改了才能保存', async () => {
      await mountEnabled();
      const input = document.body.querySelector('input[aria-label="本设备名称"]') as HTMLInputElement;
      expect(input.value).toBe('书房电脑');
      const save = () => buttons().find((b) => b.textContent === '保存')!;
      expect(save().disabled).toBe(true);
      await type(input, '  卧室电脑 ');
      expect(save().disabled).toBe(false);
      await click(save());
      expect(tauri.syncSetDeviceName).toHaveBeenCalledWith('卧室电脑');
    });

    it('设备列表：标出本机，其它设备显示上次同步时间', async () => {
      await mountEnabled();
      expect(bodyText()).toContain('我的手机');
      expect(bodyText()).toContain('本机');
      expect(bodyText()).toContain('上次同步 1 小时前');
    });

    it('同步记录：中文字段名、旧值→新值、可撤销；警告条醒目但不吓人', async () => {
      await mountEnabled();
      expect(bodyText()).toContain('终端字号');
      expect(bodyText()).toContain('来自 我的手机');
      const warning = document.body.querySelector('li[data-kind="warning"]');
      expect(warning?.textContent).toContain('另一台设备记录的 example.com 主机指纹与本机不同');
      expect(warning?.querySelector('button')).toBeNull(); // 警告没有撤销

      await click(findButton('撤销'));
      expect(tauri.syncUndo).toHaveBeenCalledWith('h1');
    });

    it('撤销失败：就地提示原因', async () => {
      vi.mocked(tauri.syncUndo).mockRejectedValueOnce({ kind: 'Other', message: '该项已被再次修改' });
      await mountEnabled();
      await click(findButton('撤销'));
      expect(bodyText()).toContain('撤销失败：该项已被再次修改');
    });

    it('停止同步：二次确认；可选同时删除云端数据（默认不勾）', async () => {
      await mountEnabled();
      await click(findButton('停止同步…'));
      expect(bodyText()).toContain('这台设备上现有的连接、设置等都会原样保留');
      const wipe = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(wipe.checked).toBe(false);

      // 默认：只停本机
      const confirmButtons = buttons().filter((b) => b.textContent === '停止同步');
      await click(confirmButtons[confirmButtons.length - 1]);
      expect(tauri.syncDisable).toHaveBeenLastCalledWith(false);
    });

    it('停止同步 + 同时删除云端：明确警示并传 true', async () => {
      await mountEnabled();
      await click(findButton('停止同步…'));
      await click(document.body.querySelector('input[type="checkbox"]')!);
      expect(bodyText()).toContain('永久删除，无法恢复');
      const confirmButtons = buttons().filter((b) => b.textContent === '停止同步');
      await click(confirmButtons[confirmButtons.length - 1]);
      expect(tauri.syncDisable).toHaveBeenLastCalledWith(true);
    });
  });
});
