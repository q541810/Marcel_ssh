import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { useSyncStore } from '@/stores/syncStore';
import { needsAttention } from '@/lib/syncModel';
import { StatusDot } from '@/components/settings/sync/syncUi';
import { RiskRulesPage } from '@/components/settings/RiskRulesPage';
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
import { MobileMcpServerSection } from './settings/MobileMcpServerSection';
import { MobileModelSection } from './settings/MobileModelSection';
import { MobileArchiveSection } from './settings/MobileArchiveSection';
import { MobileMemorySection } from './settings/MobileMemorySection';
import { MobileNotificationBackgroundSection } from './settings/MobileNotificationBackgroundSection';
import { MobileSyncSection } from './settings/MobileSyncSection';
import { registerBackHandler } from './backHandler';
import DebugPage from '@/components/debug/DebugPage';
import MobileFullscreenPage from './ui/MobileFullscreenPage';

interface MobileSettingsProps {
  /** Tab keep-alive: false while another tab is active. */
  visible?: boolean;
  /** 外部触发的初始分类（如保活卡片跳转）。消费后由 onCategoryConsumed 清理。 */
  initialCategory?: MobileSettingsCategoryId | null;
  onCategoryConsumed?: () => void;
  onShowServers?: () => void;
}

export default function MobileSettings({
  visible = true,
  initialCategory = null,
  onCategoryConsumed,
  onShowServers,
}: MobileSettingsProps) {
  const loaded = useSettingsStore((s) => s.loaded);
  const storeSettings = useSettingsStore((s) => s.settings);
  const storeUpdate = useSettingsStore((s) => s.update);
  const storeSetPreview = useSettingsStore((s) => s.setPreview);
  const storeClearPreview = useSettingsStore((s) => s.clearPreview);
  // 同步需要用户处理（出错 / 待确认 / 需升级）时，在「跨设备同步」入口上亮一个状态点。
  const syncState = useSyncStore((s) => s.status?.state);

  const [activeCategory, setActiveCategory] =
    useState<MobileSettingsCategoryId | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const { registerValidator } = useValidators();
  const clearValidationErrors = useCallback(() => setValidationErrors([]), []);

  useEffect(() => {
    if (!loaded) return;
    setDraft(storeSettings);
  }, [loaded, storeSettings]);

  // 外部跳转（如连接列表保活卡片）→ 直接进入对应分类
  useEffect(() => {
    if (!visible || !initialCategory) return;
    setActiveCategory(initialCategory);
    onCategoryConsumed?.();
  }, [visible, initialCategory, onCategoryConsumed]);

  // Tab keep-alive retains state; re-entering settings must land on the home
  // list (not the last sub-category). Clear preview if a theme trial was open.
  // pending 跳转期间不重置，避免把刚设置的分类又清掉
  useEffect(() => {
    if (visible) return;
    if (initialCategory) return;
    setDebugOpen(false);
    storeClearPreview();
    setActiveCategory(null);
    useRiskRuleFocusStore.getState().closePage();
  }, [visible, storeClearPreview, initialCategory]);

  // 「内置风险规则」二级页：命令策略分类里再推一层。打开时替换分类内容，返回键先退这一层。
  const rulesPageOpen = useRiskRuleFocusStore((s) => s.pageOpen);
  const closeRulesPage = useRiskRuleFocusStore((s) => s.closePage);
  const showRulesPage = rulesPageOpen && activeCategory === 'agent-policy';
  useEffect(() => {
    if (!visible || !showRulesPage) return;
    return registerBackHandler(() => closeRulesPage());
  }, [visible, showRulesPage, closeRulesPage]);
  // 进二级页回到顶部；返回时回到离开前的位置（分类内容是同一个滚动容器，不会自己记）。
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainScrollTop = useRef(0);
  const wasRulesPage = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || wasRulesPage.current === showRulesPage) return;
    el.scrollTop = showRulesPage ? 0 : mainScrollTop.current;
    wasRulesPage.current = showRulesPage;
  }, [showRulesPage]);

  // 进入分类时回到顶部（滚动容器不再按 activeCategory 重新挂载，必须显式重置）。
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    mainScrollTop.current = 0;
  }, [activeCategory]);

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
          className="flex-shrink-0 border-b border-edge-subtle px-3 py-3"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))' }}
        >
          {activeCategory ? (
            <button
              type="button"
              onClick={() => {
                if (showRulesPage) {
                  closeRulesPage();
                  return;
                }
                storeClearPreview();
                setActiveCategory(null);
              }}
              className="mb-1 flex items-center gap-1 text-xs text-indigo-400 active:text-indigo-300"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {showRulesPage ? '返回命令策略' : '返回设置'}
            </button>
          ) : null}
          <h1 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
            {showRulesPage ? '内置风险规则' : (activeMeta?.title ?? '设置')}
          </h1>
          {showRulesPage ? null : activeMeta?.description ? (
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
          ref={scrollRef}
          onScroll={(e) => {
            if (!showRulesPage) mainScrollTop.current = e.currentTarget.scrollTop;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {!activeCategory && (
            <nav className="flex flex-col gap-1 p-3">
              {MOBILE_SETTINGS_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className="flex items-center gap-3 rounded-xl border border-edge-subtle bg-zinc-900 px-3 py-3 text-left transition-transform duration-100 active:scale-[0.99]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                      {cat.title}
                      {cat.id === 'sync' && needsAttention(syncState) && (
                        <>
                          <StatusDot tone={syncState === 'error' ? 'error' : 'warn'} />
                          <span className="sr-only">需要处理</span>
                        </>
                      )}
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

          {activeCategory === 'agent-policy' && !showRulesPage && (
            <div className="p-3">
              <MobileAgentPolicySection />
            </div>
          )}

          {activeCategory === 'agent-policy' && showRulesPage && (
            <div key="risk-rules" className="mobile-panel-enter p-3">
              <RiskRulesPage compact />
            </div>
          )}

          {activeCategory === 'agent-tools' && (
            <div className="p-3">
              <MobileAgentToolsSection />
            </div>
          )}

          {activeCategory === 'memory' && (
            <div className="p-3">
              <MobileMemorySection />
            </div>
          )}

          {activeCategory === 'conversations' && (
            <div className="p-3">
              <MobileArchiveSection />
            </div>
          )}

          {activeCategory === 'commands-skills' && (
            <div className="p-3">
              <MobileCommandsSkillsSection />
            </div>
          )}

          {activeCategory === 'mcp-server' && (
            <div className="p-3">
              <MobileMcpServerSection />
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
              <MobileAboutSection onOpenDebug={() => setDebugOpen(true)} />
            </div>
          )}
        </div>
      </div>
      {debugOpen && visible && (
        <MobileFullscreenPage region="mobile-debug" onBack={() => setDebugOpen(false)}>
          <div className="flex min-h-0 flex-1 flex-col" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
            <DebugPage
              onBack={() => setDebugOpen(false)}
              onShowServers={() => {
                setDebugOpen(false);
                onShowServers?.();
              }}
            />
          </div>
        </MobileFullscreenPage>
      )}
    </SettingsActionsProvider>
  );
}
