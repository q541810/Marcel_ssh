import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import MobileTabBar from './MobileTabBar';
import MobileTerminalHost from './MobileTerminalHost';
import MobileAgentHost from './MobileAgentHost';
import MobileFilesHost from './MobileFilesHost';
import MobileOnboarding from './MobileOnboarding';
import MobileSettings from './MobileSettings';
import MobileUpdateToast from './MobileUpdateToast';
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

  // Android back gesture returns to the home tab before the system gets a
  // chance to finish the activity (sheets/overlays register on top of this).
  useEffect(() => {
    if (activeTab === DEFAULT_MOBILE_TAB) return;
    return registerBackHandler(() => setActiveTab(DEFAULT_MOBILE_TAB));
  }, [activeTab]);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingDone(true);
  }, []);

  // Fill the window. Layout is absolute so the bottom tab bar can stay pinned
  // under the soft keyboard while only the content area is lifted by
  // --ime-bottom (injected from MainActivity when the IME opens).
  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden bg-zinc-950 text-zinc-100"
      data-mobile-shell="1"
      style={{
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        // Tab buttons: min-h-12. Content bottom = max(tab, IME) so the
        // keyboard covers the tab bar instead of lifting it.
        ['--tab-bar-height' as string]:
          'calc(3rem + env(safe-area-inset-bottom, 0px))',
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
          <MobileSettings />
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
    </div>
  );
}
