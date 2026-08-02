import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AppSettings } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import {
  SettingsActionsProvider,
  useValidators,
} from '@/components/settings/SettingsActionsContext';
import {
  MOBILE_SETTINGS_CATEGORIES,
  type MobileSettingsCategoryId,
} from './mobileSettingsModel';
import { MobileAboutSection } from './settings/MobileAboutSection';
import { MobileAgentPolicySection } from './settings/MobileAgentPolicySection';
import { MobileAgentToolsSection } from './settings/MobileAgentToolsSection';
import { MobileAppearanceSection } from './settings/MobileAppearanceSection';
import { MobileCommandsSkillsSection } from './settings/MobileCommandsSkillsSection';
import { MobileModelSection } from './settings/MobileModelSection';
import { MobileNotificationBackgroundSection } from './settings/MobileNotificationBackgroundSection';
import { MobileSyncSection } from './settings/MobileSyncSection';
import { registerBackHandler } from './backHandler';

interface MobileSettingsProps {
  /** Tab keep-alive: false while another tab is active. */
  visible?: boolean;
}

export default function MobileSettings({
  visible = true,
}: MobileSettingsProps) {
  const loaded = useSettingsStore((s) => s.loaded);
  const storeSettings = useSettingsStore((s) => s.settings);
  const storeUpdate = useSettingsStore((s) => s.update);
  const storeSetPreview = useSettingsStore((s) => s.setPreview);
  const storeClearPreview = useSettingsStore((s) => s.clearPreview);

  const [activeCategory, setActiveCategory] =
    useState<MobileSettingsCategoryId | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const { registerValidator } = useValidators();
  const clearValidationErrors = useCallback(() => setValidationErrors([]), []);

  useEffect(() => {
    if (!loaded) return;
    setDraft(storeSettings);
  }, [loaded, storeSettings]);

  // Tab keep-alive retains state; re-entering settings must land on the home
  // list (not the last sub-category). Clear preview if a theme trial was open.
  useEffect(() => {
    if (visible) return;
    storeClearPreview();
    setActiveCategory(null);
  }, [visible, storeClearPreview]);

  // Android back gesture pops the sub-category page (mirrors the header's
  // "返回设置" button, including the preview cleanup).
  useEffect(() => {
    if (!visible || activeCategory == null) return;
    return registerBackHandler(() => {
      storeClearPreview();
      setActiveCategory(null);
    });
  }, [visible, activeCategory, storeClearPreview]);

  const updateAndPersist = useCallback(
    async (patch: Partial<AppSettings>) => {
      setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
      setSaveError(null);
      try {
        await storeUpdate(patch);
      } catch (err) {
        setSaveError(getErrorMessage(err));
      }
    },
    [storeUpdate],
  );

  const setPreview = useCallback(
    (preview: Partial<AppSettings>) => {
      storeSetPreview(preview);
    },
    [storeSetPreview],
  );

  const actionsValue = useMemo(() => {
    if (!draft) return null;
    return {
      settings: draft,
      update: (patch: Partial<AppSettings>) => {
        void updateAndPersist(patch);
      },
      setPreview,
      saving: false,
      saveError,
      validationErrors,
      registerValidator,
      clearValidationErrors,
    };
  }, [
    draft,
    updateAndPersist,
    setPreview,
    saveError,
    validationErrors,
    registerValidator,
    clearValidationErrors,
  ]);

  if (!loaded || !draft || !actionsValue) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        加载设置中…
      </div>
    );
  }

  const activeMeta = activeCategory
    ? MOBILE_SETTINGS_CATEGORIES.find((c) => c.id === activeCategory)
    : null;

  return (
    <SettingsActionsProvider value={actionsValue}>
      <div className="flex h-full min-h-0 flex-col bg-zinc-950">
        <header
          className="flex-shrink-0 border-b border-zinc-800 px-3 py-3"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))' }}
        >
          {activeCategory ? (
            <button
              type="button"
              onClick={() => {
                storeClearPreview();
                setActiveCategory(null);
              }}
              className="mb-1 flex items-center gap-1 text-xs text-indigo-400 active:text-indigo-300"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回设置
            </button>
          ) : null}
          <h1 className="text-base font-semibold text-zinc-100">
            {activeMeta?.title ?? '设置'}
          </h1>
          {activeMeta?.description ? (
            <p className="mt-0.5 text-xs text-zinc-500">
              {activeMeta.description}
            </p>
          ) : (
            !activeCategory && (
              <p className="mt-0.5 text-xs text-zinc-500">
                外观、模型、策略与快捷命令
              </p>
            )
          )}
        </header>

        {saveError && (
          <div className="flex-shrink-0 border-b border-red-900/40 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">
            {saveError}
          </div>
        )}

        <div
          key={activeCategory ?? 'root'}
          className="mobile-panel-enter min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {!activeCategory && (
            <nav className="flex flex-col gap-1 p-3">
              {MOBILE_SETTINGS_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3 text-left transition-transform duration-100 active:scale-[0.99]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-100">
                      {cat.title}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {cat.description}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-zinc-600" />
                </button>
              ))}
            </nav>
          )}

          {activeCategory === 'appearance' && (
            <div className="p-3">
              <MobileAppearanceSection />
            </div>
          )}

          {activeCategory === 'llm' && (
            <div className="p-3">
              <MobileModelSection />
            </div>
          )}

          {activeCategory === 'agent-policy' && (
            <div className="p-3">
              <MobileAgentPolicySection />
            </div>
          )}

          {activeCategory === 'agent-tools' && (
            <div className="p-3">
              <MobileAgentToolsSection />
            </div>
          )}

          {activeCategory === 'commands-skills' && (
            <div className="p-3">
              <MobileCommandsSkillsSection />
            </div>
          )}

          {activeCategory === 'notification-background' && (
            <div className="p-3">
              <MobileNotificationBackgroundSection />
            </div>
          )}

          {activeCategory === 'sync' && (
            <div className="p-3">
              <MobileSyncSection />
            </div>
          )}

          {activeCategory === 'about' && (
            <div className="p-3">
              <MobileAboutSection />
            </div>
          )}
        </div>
      </div>
    </SettingsActionsProvider>
  );
}
