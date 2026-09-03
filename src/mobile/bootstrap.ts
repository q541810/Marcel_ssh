import type { AgentMode } from '@/lib/types';
import { appReady, checkUpdate } from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSkillStore } from '@/stores/skillStore';
import { attachTransferListeners } from '@/stores/sftpTransferManager';
import { hydrateBootstrapData } from '@/lib/bootstrap';
import {
  isAndroidBridgeAvailable,
  isNotificationPermissionGranted,
  startForegroundService,
} from './mobileBridge';

const VALID_AGENT_MODES: readonly AgentMode[] = ['plan', 'agent', 'auto'];

export function resolveBootstrapMode(
  defaultAgentMode: string | undefined | null,
): AgentMode | null {
  if (!defaultAgentMode) return null;
  if ((VALID_AGENT_MODES as readonly string[]).includes(defaultAgentMode)) {
    return defaultAgentMode as AgentMode;
  }
  return null;
}

export interface MobileBootstrapDeps {
  /** Window starts visible:false — must show early (desktop App does this). */
  appReady: () => Promise<void>;
  loadSettings: () => Promise<void>;
  getDefaultAgentMode: () => string | undefined | null;
  setMode: (mode: AgentMode) => void;
  fetchSkills: () => Promise<void>;
  attachTransferListeners: () => void | Promise<void>;
  /**
   * 按 mobileBackgroundSettings.keepAliveEnabled 启动 Android 前台保活服务。
   * 非 Android 环境（桌面 / 浏览器预览）应安全 no-op。
   */
  startForegroundServiceIfEnabled: () => void;
  checkUpdate: () => Promise<{
    hasUpdate: boolean;
    latestVersion: string;
    releaseUrl: string;
  }>;
  onUpdateAvailable: (version: string, url: string) => void;
}

export async function runMobileBootstrap(
  deps: MobileBootstrapDeps,
): Promise<void> {
  // Show window first so a hung settings/skills load never leaves a blank process.
  try {
    await deps.appReady();
  } catch {
    /* browser preview has no tauri */
  }
  // 聚合启动快照：一次性 Hydrate 设置、连接 与 Skills
  await deps.loadSettings();
  const mode = resolveBootstrapMode(deps.getDefaultAgentMode());
  if (mode) {
    deps.setMode(mode);
  }
  // 启动前台保活服务：必须在 loadSettings 之后、其他长任务之前。
  // 服务持有 WakeLock 防止 CPU 休眠，SSH keepalive 与 Agent tokio 任务得以持续。
  // 非 Android 环境 / 未开启保活时为 no-op。
  try {
    deps.startForegroundServiceIfEnabled();
  } catch {
    /* best-effort：保活失败不阻塞其他功能 */
  }
  try {
    await deps.fetchSkills();
  } catch {
    /* best-effort */
  }
  await deps.attachTransferListeners();
  // Update check last and silent-on-failure: never blocks interaction.
  try {
    const result = await deps.checkUpdate();
    if (result.hasUpdate) {
      deps.onUpdateAvailable(result.latestVersion, result.releaseUrl);
    }
  } catch {
    /* offline / server unreachable — stay silent */
  }
}

let bootstrapStarted = false;

export interface MobileBootstrapCallbacks {
  onUpdateAvailable: (version: string, url: string) => void;
}

export async function bootstrapMobileApp(
  callbacks: MobileBootstrapCallbacks,
): Promise<void> {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  try {
    await runMobileBootstrap({
      appReady: () => appReady(),
      loadSettings: () => hydrateBootstrapData(),
      getDefaultAgentMode: () =>
        useSettingsStore.getState().settings.defaultAgentMode,
      setMode: (mode) => useTaskStore.getState().setMode(mode),
      fetchSkills: () => useSkillStore.getState().fetchSkills(),
      attachTransferListeners: () => attachTransferListeners(),
      startForegroundServiceIfEnabled: () => {
        const { mobileBackgroundSettings } =
          useSettingsStore.getState().settings;
        if (!mobileBackgroundSettings.keepAliveEnabled) return;
        if (!isAndroidBridgeAvailable()) return;
        // 启动时不弹权限请求（避免每次启动打扰用户）。
        // 若权限未授予，前台服务仍可运行，只是常驻通知不可见；
        // 用户可在「后台保活」设置页手动授予权限。
        if (!isNotificationPermissionGranted()) {
          console.warn(
            '[mobile] 通知权限未授予，前台服务将运行但常驻通知不可见',
          );
        }
        startForegroundService('Marcel SSH', '运行中');
      },
      checkUpdate: () => checkUpdate(),
      onUpdateAvailable: callbacks.onUpdateAvailable,
    });
  } catch (err) {
    bootstrapStarted = false;
    console.error('[mobile] bootstrap failed:', err);
    throw err;
  }
}

export function resetMobileBootstrapForTests(): void {
  bootstrapStarted = false;
}
