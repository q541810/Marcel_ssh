// @vitest-environment jsdom
/**
 * fileNav 的「递交」部分：桌面能不能把文件管理器请出来、手机记下从哪来。
 * 动作清单 / 机器解析等纯逻辑在 fileLink.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mobile: false,
  sftpListDir: vi.fn(),
  tab: 'agent' as string,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(async () => true), stat: vi.fn(async () => ({})) }));
vi.mock('@/lib/tauri', () => ({
  sftpHomeDir: vi.fn(async () => '/home/u'),
  sftpListDir: mocks.sftpListDir,
  revealLocalPath: vi.fn(async () => {}),
}));
vi.mock('@/lib/fileShellActions', () => ({ sendCdToTerminal: vi.fn(async () => {}) }));
vi.mock('@/lib/copyText', () => ({ copyText: vi.fn(async () => {}) }));
vi.mock('@/platform', () => ({
  collectPlatformHints: () => ({}),
  isMobilePlatform: () => mocks.mobile,
}));
vi.mock('@/stores/sessionConversationBindingManager', () => ({
  sessionConversationBindingManager: { findOccupyingSession: () => null },
}));

import { canShowFileManager, runFileAction } from './fileNav';
import { registerBottomPanelHost, OPEN_BOTTOM_TAB_EVENT } from './bottomPanelNav';
import { OPEN_AGENT_PANEL_EVENT } from './agentPanelNav';
import { reportMobileTab, MOBILE_SWITCH_TAB_EVENT, type MobileTabId } from '@/mobile/tabs';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useFileNavStore } from '@/stores/fileNavStore';
import type { FileRef } from './fileLink';

const REF: FileRef = { side: 'remote', host: 'web', path: '/srv/app/a.md' };

function setLayout(patch: Record<string, unknown>) {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: { ...settings, workspaceLayout: { ...settings.workspaceLayout, ...patch } },
  });
}

const events: string[] = [];
const listeners: Array<[string, EventListener]> = [];
function record(name: string) {
  const fn: EventListener = (e) => events.push(`${name}:${JSON.stringify((e as CustomEvent).detail ?? null)}`);
  window.addEventListener(name, fn);
  listeners.push([name, fn]);
}

beforeEach(() => {
  mocks.mobile = false;
  events.length = 0;
  mocks.sftpListDir.mockReset();
  mocks.sftpListDir.mockResolvedValue([{ name: 'a.md', is_dir: false, size: 5 }]);
  useConnectionStore.setState({ connections: [{ id: 'c1', name: 'web' }] as never });
  useSessionStore.setState({
    sessions: { s1: { id: 's1', configId: 'c1', connectionId: 'c1', status: 'connected', createdAt: '2026-01-01' } as never },
    activeSessionId: null,
  });
  useFileNavStore.setState({ pending: {}, notice: null });
  setLayout({ agentOpen: true, agentPrimary: false });
  record(OPEN_BOTTOM_TAB_EVENT);
  record(OPEN_AGENT_PANEL_EVENT);
  record(MOBILE_SWITCH_TAB_EVENT);
});

afterEach(() => {
  for (const [name, fn] of listeners.splice(0)) window.removeEventListener(name, fn);
  reportMobileTab('terminal');
});

describe('canShowFileManager（桌面）', () => {
  it('底栏没挂载、也没有被收起的终端栏可请：不可用（菜单据此藏起文件管理项）', () => {
    expect(canShowFileManager()).toBe(false);
  });

  it('底栏挂着：可用；卸载后又不可用', () => {
    const unregister = registerBottomPanelHost();
    expect(canShowFileManager()).toBe(true);
    unregister();
    expect(canShowFileManager()).toBe(false);
  });

  it('Agent 占主区域且终端栏被收起：可用（递交时会先把那一栏请出来）', () => {
    setLayout({ agentPrimary: true, agentOpen: false });
    expect(canShowFileManager()).toBe(true);
    setLayout({ agentPrimary: true, agentOpen: true });
    expect(canShowFileManager()).toBe(false);
  });

  it('手机：文件页永远在', () => {
    mocks.mobile = true;
    expect(canShowFileManager()).toBe(true);
  });
});

describe('runFileAction 递交到文件管理器', () => {
  it('桌面底栏在场：切会话、请求切到文件管理标签、待办进信箱；不必请出右侧栏', async () => {
    const unregister = registerBottomPanelHost();
    await runFileAction('reveal', REF);
    unregister();
    expect(useSessionStore.getState().activeSessionId).toBe('s1');
    expect(events.some((e) => e.startsWith(OPEN_BOTTOM_TAB_EVENT) && e.includes('file-manager'))).toBe(true);
    expect(events.some((e) => e.startsWith(OPEN_AGENT_PANEL_EVENT))).toBe(false);
    expect(useFileNavStore.getState().pending.s1).toMatchObject({ path: '/srv/app/a.md', intent: 'reveal', returnTo: null });
  });

  it('Agent 占主区域且终端栏收着：先请出终端栏，再请求文件管理标签', async () => {
    setLayout({ agentPrimary: true, agentOpen: false });
    await runFileAction('reveal', REF);
    const open = events.findIndex((e) => e.startsWith(OPEN_AGENT_PANEL_EVENT));
    const tab = events.findIndex((e) => e.startsWith(OPEN_BOTTOM_TAB_EVENT));
    expect(open).toBeGreaterThanOrEqual(0);
    expect(tab).toBeGreaterThan(open);
  });

  it('没有任何办法把文件管理器亮出来时：给一句提示，不静默无事发生，也不留待办', async () => {
    await runFileAction('reveal', REF);
    expect(useFileNavStore.getState().notice?.text).toContain('文件管理');
    expect(useFileNavStore.getState().pending.s1).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('手机：记下用户从哪个页签来，再切到文件页', async () => {
    mocks.mobile = true;
    reportMobileTab('agent' satisfies MobileTabId);
    await runFileAction('open', REF);
    expect(useFileNavStore.getState().pending.s1).toMatchObject({ returnTo: 'agent', intent: 'auto' });
    expect(events.some((e) => e.startsWith(MOBILE_SWITCH_TAB_EVENT) && e.includes('files'))).toBe(true);
  });

  it('手机：本来就在文件页发起的，不记返回（没有地方可回）', async () => {
    mocks.mobile = true;
    reportMobileTab('files');
    await runFileAction('reveal', REF);
    expect(useFileNavStore.getState().pending.s1?.returnTo).toBeNull();
  });

  it('「在终端中进入所在目录」不借文件管理器，文件管理器不可用时仍能执行（不被拦）', async () => {
    await runFileAction('cd', REF);
    expect(useFileNavStore.getState().notice?.text ?? '').not.toContain('文件管理');
  });
});
