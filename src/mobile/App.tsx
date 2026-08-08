import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import MobileTabBar from './MobileTabBar';
import MobileTerminalHost from './MobileTerminalHost';
import MobileAgentHost from './MobileAgentHost';
import MobileFilesHost from './MobileFilesHost';
import MobileOnboarding from './MobileOnboarding';
import MobileSettings from './MobileSettings';
import MobileSyncConflictSheet from './MobileSyncConflictSheet';
import MobileUpdateToast from './MobileUpdateToast';
import MobileStarPromptSheet from './MobileStarPromptSheet';
import { mobileSetAppForeground } from '@/lib/tauri';
import { bootstrapMobileApp } from './bootstrap';
import { registerBackHandler } from './backHandler';
import { panelVisibilityClass } from './sessionUi';
import { DEFAULT_MOBILE_TAB, type MobileTabId } from './tabs';

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState<MobileTabId>(DEFAULT_MOBILE_TAB);
  const [updateToast, setUpdateToast] = useState<{
    version: string;
    url: string;
  } | null>(null);
  // Dismissed-this-session guard so finishing onboarding hides it immediately
  // even before the settings write lands.
  const [onboardingDone, setOnboardingDone] = useState(false);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const hasCompletedOnboarding = useSettingsStore(
    (s) => s.settings.hasCompletedOnboarding,
  );
  const showOnboarding =
    settingsLoaded && !hasCompletedOnboarding && !onboardingDone;

  useEffect(() => {
    void bootstrapMobileApp({
      onUpdateAvailable: (version, url) => setUpdateToast({ version, url }),
    }).catch(() => {});
  }, []);

  // Android WebView may still pan the document when an input focuses (despite
  // overflow:hidden). Snap scroll back so users cannot drag into the blank
  // strip under the IME and reveal the pinned tab bar.
  useEffect(() => {
    const snap = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
      if (document.documentElement.scrollTop !== 0) {
        document.documentElement.scrollTop = 0;
      }
      if (document.body.scrollTop !== 0) {
        document.body.scrollTop = 0;
      }
    };
    const onFocusIn = () => {
      requestAnimationFrame(snap);
      window.setTimeout(snap, 50);
      window.setTimeout(snap, 300);
    };
    window.addEventListener('scroll', snap, { passive: true });
    document.addEventListener('focusin', onFocusIn);
    const vv = window.visualViewport;
    vv?.addEventListener('scroll', snap);
    vv?.addEventListener('resize', snap);
    return () => {
      window.removeEventListener('scroll', snap);
      document.removeEventListener('focusin', onFocusIn);
      vv?.removeEventListener('scroll', snap);
      vv?.removeEventListener('resize', snap);
    };
  }, []);

  // Android back gesture returns to the home tab before the system gets a
  // chance to finish the activity (sheets/overlays register on top of this).
  useEffect(() => {
    if (activeTab === DEFAULT_MOBILE_TAB) return;
    return registerBackHandler(() => setActiveTab(DEFAULT_MOBILE_TAB));
  }, [activeTab]);

  // 切前台时触发刷新信号。Rust 侧 RunEvent::Resumed 也会 emit mobile://lifecycle，
  // 但 visibilitychange 更贴近 WebView 实际恢复时机（JS 引擎解冻）。
  // 切后台时 SSH/Agent 在 Rust 内存里持续运行（前台服务保活），事件可能积压，
  // 切前台后批量触发；本信号让需要刷新的组件（如 xterm）有机会主动重绘。
  // 同时把前后台同步给 Rust：前台不发 Agent 系统通知，后台才发。
  useEffect(() => {
    const reportForeground = (inForeground: boolean) => {
      mobileSetAppForeground(inForeground).catch(() => {});
    };
    reportForeground(document.visibilityState === 'visible');

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        reportForeground(true);
        window.dispatchEvent(new CustomEvent('mobile:foreground'));
      } else {
        reportForeground(false);
        window.dispatchEvent(new CustomEvent('mobile:background'));
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingDone(true);
  }, []);

  // Fill the window. Layout is absolute so the bottom tab bar can stay pinned
  // under the soft keyboard while only the content area is lifted by
  // --ime-bottom (injected from MainActivity when the IME opens).
  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden overscroll-none bg-zinc-950 text-zinc-100"
      data-mobile-shell="1"
      style={{
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        // Tab buttons: min-h-12. Content bottom = max(tab, IME) so the
        // keyboard covers the tab bar instead of lifting it. The navigation
        // bar (3-button nav) is injected as --nav-bar-bottom from MainActivity
        // (env(safe-area-inset-bottom) ignores it on Android WebView).
        ['--tab-bar-height' as string]:
          'calc(3rem + max(env(safe-area-inset-bottom, 0px), var(--nav-bar-bottom, 0px)))',
      }}
    >
      <main
        className="absolute inset-x-0 top-0 overflow-hidden"
        style={{
          bottom:
            'max(var(--tab-bar-height), var(--ime-bottom, 0px))',
        }}
      >
        <div
          className={`absolute inset-0 ${panelVisibilityClass(activeTab === 'terminal')}`}
        >
          <MobileTerminalHost visible={activeTab === 'terminal'} />
        </div>
        <div
          className={`absolute inset-0 ${panelVisibilityClass(activeTab === 'agent')}`}
        >
          <MobileAgentHost visible={activeTab === 'agent'} />
        </div>
        <div
          className={`absolute inset-0 ${panelVisibilityClass(activeTab === 'files')}`}
        >
          <MobileFilesHost visible={activeTab === 'files'} />
        </div>
        <div
          className={`absolute inset-0 ${panelVisibilityClass(activeTab === 'settings')}`}
        >
          <MobileSettings visible={activeTab === 'settings'} />
        </div>

      </main>
      <div className="absolute inset-x-0 bottom-0">
        <MobileTabBar activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {updateToast && !showOnboarding && (
        <MobileUpdateToast
          version={updateToast.version}
          url={updateToast.url}
          onDismiss={() => setUpdateToast(null)}
        />
      )}

      {showOnboarding && (
        <MobileOnboarding onComplete={handleOnboardingComplete} />
      )}

      <MobileSyncConflictSheet />
      <MobileStarPromptSheet />
    </div>
  );
}
