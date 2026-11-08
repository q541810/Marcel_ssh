// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as tauri from '@/lib/tauri';
import { useSyncStore } from '@/stores/syncStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { SearchRegistryProvider } from '@/components/settings/helpers';
import type { SyncDevice, SyncHistoryEntry, SyncStatus, TierEstimate } from '@/lib/types';
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
  syncSetTier: vi.fn(),
  syncTierEstimate: vi.fn(),
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
  { id: 'dev-self', name: '书房电脑', platform: 'desktop', appVersion: '1.12.0', lastSeenAt: new Date().toISOString(), isSelf: true, tiers: { config: true, conversation: true, secret: false } },
  { id: 'dev-phone', name: '我的手机', platform: 'android', appVersion: '1.12.0', lastSeenAt: new Date(Date.now() - 3600_000).toISOString(), isSelf: false, tiers: { config: true, conversation: false, secret: true } },
];

/** `sync_tier_estimate` 的默认返回：对话档给数量，机密档给分组（**只有名字与数量**）。 */
const CONVERSATION_ESTIMATE: TierEstimate = {
  tier: 'conversation',
  conversations: 42,
  images: 7,
  totalBytes: 12 * 1024 * 1024,
  secretGroups: [],
};

const SECRET_ESTIMATE: TierEstimate = {
  tier: 'secret',
  conversations: 0,
  images: 0,
  totalBytes: 0,
  secretGroups: [
    { label: '模型渠道 API Key', count: 3, names: ['DeepSeek', 'Kimi', '智谱'] },
    { label: '服务器密码', count: 5, names: ['生产服务器', '家里的 NAS'] },
    { label: '私钥口令', count: 2, names: ['work-key', 'backup-key'] },
  ],
};

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
  {
    id: 'h3',
    at: new Date(Date.now() - 1_800_000).toISOString(),
    deviceName: '我的手机',
    source: 'secrets',
    path: 'llm_channel_c1',
    label: "模型渠道『DeepSeek』的 API Key 已从另一台设备更新",
    // 后端即使给了值，界面也不该画出来
    oldValue: 'sk-old-should-never-render',
    newValue: 'sk-new-should-never-render',
    kind: 'change',
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
    tauri.syncSetTier,
  ]) {
    vi.mocked(fn).mockReset().mockResolvedValue(undefined);
  }
  vi.mocked(tauri.syncTierEstimate).mockReset().mockResolvedValue(CONVERSATION_ESTIMATE);
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

    it('同步码：粘贴后加入；默认「合并」并说明冲突以云端为准', async () => {
      await openJoin();
      expect(bodyText()).toContain('同一项两边不一样时，以云端为准');
      const join = () => buttons().filter((b) => b.textContent === '加入').pop()!;
      expect(join().disabled).toBe(true);
      await type(inputByLabel('同步码'), '  MSYNC1-' + 'a'.repeat(60) + '\n');
      expect(join().disabled).toBe(false);
      await click(join());
      expect(tauri.syncJoin).toHaveBeenCalledWith('MSYNC1-' + 'a'.repeat(60), 'merge');
      await vi.waitFor(() => expect(bodyText()).not.toContain('同一项两边不一样时，以云端为准'));
      expect(bodyText()).toContain('已加入同步');
    });

    it('扫码入口只在手机端出现：桌面端加同步码这一步没有相机可用', async () => {
      await openJoin();
      const scan = [...document.body.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').trim() === '扫码',
      );
      if (variant === 'mobile') expect(scan).toBeTruthy();
      else expect(scan).toBeUndefined();
    });

    it('同步码不对：后端的原因显示出来，向导不关', async () => {      vi.mocked(tauri.syncJoin).mockRejectedValueOnce({ kind: 'Other', message: '恢复密钥不对' });
      await openJoin();
      await type(inputByLabel('同步码'), 'MSYNC1-' + 'a'.repeat(60));
      await click(buttons().filter((b) => b.textContent === '加入').pop()!);
      expect(bodyText()).toContain('恢复密钥不对');
      expect(bodyText()).toContain('同一项两边不一样时，以云端为准');
    });

    it('以云端为准：先看到会丢弃什么，选中后按 cloud 提交', async () => {
      await openJoin();
      expect(bodyText()).not.toContain('会被丢弃');
      await click(findButton('以云端为准'));
      expect(bodyText()).toContain('本机独有的连接');
      expect(bodyText()).toContain('会被丢弃');
      await type(inputByLabel('同步码'), 'MSYNC1-' + 'a'.repeat(60));
      await click(buttons().filter((b) => b.textContent === '加入').pop()!);
      expect(tauri.syncJoin).toHaveBeenCalledWith('MSYNC1-' + 'a'.repeat(60), 'cloud');
    });

    it('以本机为准：提示别给新设备选，按 local 提交', async () => {
      await openJoin();
      await click(findButton('以本机为准'));
      expect(bodyText()).toContain('刚装的新设备');
      await type(inputByLabel('同步码'), 'MSYNC1-' + 'a'.repeat(60));
      await click(buttons().filter((b) => b.textContent === '加入').pop()!);
      expect(tauri.syncJoin).toHaveBeenCalledWith('MSYNC1-' + 'a'.repeat(60), 'local');
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
        'merge',
      );
    });
  });

  describe('已开启', () => {
    async function mountEnabled(s: SyncStatus = status()) {
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(s);
      mount(variant);
      await flush();
    }

    it('状态行、存放位置、同步范围（三档都能点了，不再有「后续版本支持」）', async () => {
      await mountEnabled();
      const text = bodyText();
      expect(text).toContain('已同步 · 5 分钟前');
      expect(text).toContain('WebDAV · dav.jianguoyun.com · marcel-sync');
      expect(text).toContain('普通配置');
      expect(text).toContain('对话与记忆');
      expect(text).toContain('机密');
      // 三期做完后这条字符串应该彻底消失（防止有人加回来）
      expect(text.match(/后续版本支持/g) ?? []).toHaveLength(0);
      // 普通配置恒开且不可关；另外两档按 status.tiers 显示、可点
      const switches = Array.from(document.body.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
      expect(switches).toHaveLength(3);
      expect(switches[0].getAttribute('aria-checked')).toBe('true');
      expect(switches[0].disabled).toBe(true);
      expect(switches[1].disabled).toBe(false);
      expect(switches[2].disabled).toBe(false);
      expect(switches[1].getAttribute('aria-checked')).toBe('false');
      expect(switches[2].getAttribute('aria-checked')).toBe('false');
    });

    it('档位开关的初始态来自 status.tiers', async () => {
      await mountEnabled(status({ tiers: { config: true, conversation: true, secret: true } }));
      const switches = Array.from(document.body.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
      expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);
      // 只有普通配置不可点
      expect(switches.map((s) => s.disabled)).toEqual([true, false, false]);
    });

    it('打开「对话与记忆」：先弹说明 + 估算，确认后才 setTier', async () => {
      await mountEnabled();
      const conversationSwitch = () =>
        document.body.querySelector('[data-tier="conversation"] [role="switch"]') as HTMLButtonElement;

      await click(conversationSwitch());
      // 弹的是说明而不是直接开关
      expect(tauri.syncSetTier).not.toHaveBeenCalled();
      expect(tauri.syncTierEstimate).toHaveBeenCalledWith('conversation');
      expect(bodyText()).toContain('打开「对话与记忆」同步');
      expect(bodyText()).toContain('服务器的输出和命令结果');
      expect(bodyText()).toContain('端到端加密');
      await vi.waitFor(() => expect(bodyText()).toContain('42'));
      expect(bodyText()).toContain('7');
      expect(bodyText()).toContain('MB');

      await click(findButton('打开同步'));
      expect(tauri.syncSetTier).toHaveBeenCalledWith('conversation', true, 'merge');
    });

    it('打开「对话与记忆」时取消勾选「也上传已有的」：按 cloud 提交，本机内容不删', async () => {
      await mountEnabled();
      await click(document.body.querySelector('[data-tier="conversation"] [role="switch"]')!);
      expect(bodyText()).toContain('把这台设备上已有的对话与记忆也上传');
      await click(document.body.querySelector('input[type="checkbox"]')!);
      expect(bodyText()).toContain('不会被删除，只是不上传');
      await click(findButton('打开同步'));
      expect(tauri.syncSetTier).toHaveBeenCalledWith('conversation', true, 'cloud');
    });

    it('对话档估算失败：只说明并给重试，仍然放行', async () => {
      vi.mocked(tauri.syncTierEstimate).mockRejectedValue({ kind: 'Other', message: '库正在被占用' });
      await mountEnabled();
      await click(document.body.querySelector('[data-tier="conversation"] [role="switch"]')!);
      await vi.waitFor(() => expect(bodyText()).toContain('库正在被占用'));
      expect(bodyText()).toContain('重试');
      expect(findButton('打开同步').disabled).toBe(false);
    });

    it('打开「机密」：说明里列出类别与数量，页面上不出现任何像密钥的值', async () => {
      vi.mocked(tauri.syncTierEstimate).mockResolvedValue(SECRET_ESTIMATE);
      await mountEnabled();
      await click(document.body.querySelector('[data-tier="secret"] [role="switch"]')!);
      expect(tauri.syncTierEstimate).toHaveBeenCalledWith('secret');
      await vi.waitFor(() => expect(bodyText()).toContain('模型渠道 API Key'));
      expect(bodyText()).toContain('3');
      expect(bodyText()).toContain('服务器密码');
      expect(bodyText()).toContain('私钥口令');
      expect(bodyText()).toContain('DeepSeek');
      expect(bodyText()).toContain('恢复密钥或同步码');
      // 只有名称与数量，绝不该出现像值的东西
      expect(bodyText()).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(bodyText()).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);

      await click(findButton('打开同步'));
      expect(tauri.syncSetTier).toHaveBeenCalledWith('secret', true, 'merge');
    });

    it('关闭「机密」：先提示「已经同步出去的不会被收回」，确认后才 setTier(false)', async () => {
      await mountEnabled(status({ tiers: { config: true, conversation: false, secret: true } }));
      await click(document.body.querySelector('[data-tier="secret"] [role="switch"]')!);
      expect(tauri.syncSetTier).not.toHaveBeenCalled();
      expect(bodyText()).toContain('已经同步到其它设备的机密不会被收回');
      await click(findButton('仍然关闭'));
      expect(tauri.syncSetTier).toHaveBeenCalledWith('secret', false, 'merge');
    });

    it('关闭「对话与记忆」：不弹确认，直接关并给一句「别处的不会被删」', async () => {
      await mountEnabled(status({ tiers: { config: true, conversation: true, secret: false } }));
      await click(document.body.querySelector('[data-tier="conversation"] [role="switch"]')!);
      expect(tauri.syncSetTier).toHaveBeenCalledWith('conversation', false, 'merge');
      await vi.waitFor(() => expect(bodyText()).toContain('已经同步到其它设备的对话不会被删除'));
    });

    it('打开失败：错误留在对应档位那行', async () => {
      vi.mocked(tauri.syncSetTier).mockRejectedValue({ kind: 'Other', message: '同步正在运行，请稍后再试' });
      await mountEnabled();
      await click(document.body.querySelector('[data-tier="secret"] [role="switch"]')!);
      await click(findButton('打开同步'));
      await vi.waitFor(() => expect(bodyText()).toContain('同步正在运行，请稍后再试'));
      expect(document.body.querySelector('[data-tier="secret"] [role="alert"]')).not.toBeNull();
    });

    it('对话档正在同步时显示「正在同步对话 N / M」，做完就消失', async () => {
      await mountEnabled(
        status({
          tiers: { config: true, conversation: true, secret: false },
          streams: [
            {
              key: 'conv',
              tier: 'conversation',
              pending: 0,
              lastError: null,
              progress: { done: 3, total: 8, label: '正在同步对话' },
            },
          ],
        }),
      );
      expect(bodyText()).toContain('正在同步对话 3 / 8');
      expect(bodyText()).toContain('38%');
    });

    it('设备列表显示每台设备开了哪几档', async () => {
      await mountEnabled();
      expect(document.body.querySelector('[aria-label="开启了配置、对话"]')).not.toBeNull();
      expect(document.body.querySelector('[aria-label="开启了配置、机密"]')).not.toBeNull();
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

    it('添加设备：默认不取同步码；点显示才取，并提醒等同于钥匙；桌面有放大二维码入口、手机没有', async () => {
      await mountEnabled();
      expect(tauri.syncGetSyncCode).not.toHaveBeenCalled();
      expect(document.body.querySelector('[data-testid="sync-code"]')).toBeNull();

      await click(findButton('显示同步码'));
      expect(tauri.syncGetSyncCode).toHaveBeenCalledTimes(1);
      expect(document.body.querySelector('[data-testid="sync-code"]')?.textContent).toContain('MSYNC1-');
      expect(bodyText()).toContain('等同于钥匙本身');
      // 设置行里**不再内联画小二维码**：控件列 280~320px 装不下能扫的码
      // （SFTP 同步码 133 模块，每格至少 3 设备像素 = 399px）。只有放大弹层里那张。
      expect(document.body.querySelector('svg[aria-label="同步码二维码"]')).toBeNull();
      // 「放大二维码」只在桌面出现：手机用不着扫自己屏幕上的码
      const zoom = [...document.body.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('放大二维码'),
      );
      if (variant === 'desktop') expect(zoom).toBeTruthy();
      else expect(zoom).toBeUndefined();

      await click(findButton('复制同步码'));
      expect(copy).toHaveBeenCalledWith('MSYNC1-' + 'Zm9v'.repeat(30));
      await click(findButton('隐藏'));
      await vi.waitFor(() => expect(document.body.querySelector('[data-testid="sync-code"]')).toBeNull());
    });

    it('桌面端放大二维码：点开是白底黑块的大图，每格整数设备像素；关掉后回到设置页', async () => {
      if (variant !== 'desktop') return;
      await mountEnabled();
      await click(findButton('显示同步码'));
      await click(findButton('放大二维码'));

      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain('用手机扫描');
      const big = dialog!.querySelector('svg[aria-label="同步码二维码"]');
      expect(big).not.toBeNull();
      // 白底黑块，不跟深浅色主题走
      expect(big!.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
      expect(big!.querySelector('path')?.getAttribute('fill')).toBe('#000000');
      // viewBox 宽度必须是模块数的整数倍，倍数不小于 3
      const [vbW] = (big!.getAttribute('viewBox') ?? '').split(' ').slice(2).map(Number);
      expect(vbW).toBeGreaterThan(0);
      expect(Number.isInteger(vbW)).toBe(true);

      // 弹层右上角是纯图标按钮，只能按 aria-label 找
      const close = dialog!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
      expect(close).not.toBeNull();
      await click(close!);
      await vi.waitFor(() => expect(document.body.textContent).not.toContain('用手机扫描'));
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

    it('同步记录里的机密条目：只写「哪个 Key」，绝不显示值，也不给撤销', async () => {
      await mountEnabled();
      const text = bodyText();
      expect(text).toContain("模型渠道『DeepSeek』的 API Key 已从另一台设备更新");
      expect(text).not.toContain('sk-old-should-never-render');
      expect(text).not.toContain('sk-new-should-never-render');
      // 机密记录的撤销会再写一遍密钥链，界面不提供（后端也没有对应记录）
      const secretItem = Array.from(document.body.querySelectorAll('li')).find((li) =>
        li.textContent?.includes('DeepSeek'),
      );
      expect(secretItem?.querySelector('button')).toBeNull();
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
