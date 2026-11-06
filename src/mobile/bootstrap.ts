import type { AgentMode } from '@/lib/types';
import { appReady, sftpPreviewCleanup } from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSkillStore } from '@/stores/skillStore';
import { attachTransferListeners } from '@/stores/sftpTransferManager';
import { hydrateBootstrapData } from '@/lib/bootstrap';
import {
  bindSystemChromeToTheme,
  isAndroidBridgeAvailable,
  isNotificationPermissionGranted,
  startForegroundService,
  syncSystemInsets,
} from './mobileBridge';
import { initLiveActivitySync } from './liveActivitySync';

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
  /**
   * 启动清理图片预览临时文件（`marcel-previews/`）。
   * 移动端预览大图后进程被系统回收时，这些临时文件会留在 app_data 里只增不减
   * （单张上限 50MB），必须在启动时扫一次 —— 桌面已在同样的时机清理。
   */
  cleanupPreviewTemp: () => Promise<void>;
  loadSettings: () => Promise<void>;
  getDefaultAgentMode: () => string | undefined | null;
  setMode: (mode: AgentMode) => void;
  attachTransferListeners: () => void;
  /**
   * 按 mobileBackgroundSettings.keepAliveEnabled 启动 Android 前台保活服务。
   * 非 Android 环境（桌面 / 浏览器预览）应安全 no-op。
   */
  startForegroundServiceIfEnabled: () => void;
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
  // 清理上次进程被回收时留下的预览临时文件：best-effort，失败不阻塞启动。
  try {
    void deps.cleanupPreviewTemp().catch(() => {
      /* 清理失败不影响启动 */
    });
  } catch {
    /* best-effort（同步抛出同样忽略） */
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
  // skills 已随 hydrateBootstrapData 的启动快照水合（含聚合失败降级路径的
  // fetchSkills），这里不再单独拉一遍。
  deps.attachTransferListeners();
  // 更新检查不在这里做：后端 updater 启动 30 秒后自查并 emit update://state，
  // 前端由 useUpdateStore 统一镜像（桌面与移动端同一份状态、同一套 UI 判定），
  // 避免两端各写一遍「检查 + 提示」逻辑。
}

let bootstrapStarted = false;

/**
 * 移动端启动。
 *
 * 更新入口不在此处：见 `MobileApp` 里 `useUpdateStore.init()`（订阅后端
 * `update://state`），浮层由 `MobileUpdateToast` 呈现。
 */
export async function bootstrapMobileApp(): Promise<void> {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  // 最先做：底栏避让导航键靠它，不该等设置加载。
  syncSystemInsets();
  // 状态栏图标与窗口底色跟主题走（订阅时回放启动早期已应用的缓存主题）。
  bindSystemChromeToTheme();
  try {
    await runMobileBootstrap({
      appReady: () => appReady(),
      cleanupPreviewTemp: () => sftpPreviewCleanup(),
      loadSettings: () => hydrateBootstrapData(),
      getDefaultAgentMode: () =>
        useSettingsStore.getState().settings.defaultAgentMode,
      setMode: (mode) => useTaskStore.getState().setMode(mode),
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
    });
    // 实时活动：设置已水合，之后任务表的变化才有意义。非 Android 环境 no-op。
    initLiveActivitySync();
  } catch (err) {
    bootstrapStarted = false;
    console.error('[mobile] bootstrap failed:', err);
    throw err;
  }
}

export function resetMobileBootstrapForTests(): void {
  bootstrapStarted = false;
}
