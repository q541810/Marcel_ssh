import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { useSyncStore } from '@/stores/syncStore';
import { needsAttention } from '@/lib/syncModel';
import { StatusDot } from '@/components/settings/sync/syncUi';
import { RiskRulesPage } from '@/components/settings/RiskRulesPage';
import { groupSettingsPages } from '@/lib/settingsCatalog';
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
import { MobileAppearancePage } from './settings/MobileAppearancePage';
import { MobileToolsPage } from './settings/MobileToolsPage';
import { MobileModelSection } from './settings/MobileModelSection';
import { MobileMemorySection } from './settings/MobileMemorySection';
import { MobileNotificationBackgroundSection } from './settings/MobileNotificationBackgroundSection';
import { MobileSyncSection } from './settings/MobileSyncSection';
import DebugPage from '@/components/debug/DebugPage';
import MobileFullscreenPage from './ui/MobileFullscreenPage';
import MobileStackPage from './ui/MobileStackPage';

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

  // 「内置风险规则」二级页：叠在 Agent 分类页上面再推一层，返回键先退这一层。
  const rulesPageOpen = useRiskRuleFocusStore((s) => s.pageOpen);
  const closeRulesPage = useRiskRuleFocusStore((s) => s.closePage);
  const showRulesPage = rulesPageOpen && activeCategory === 'agent';

  // 分类页 / 风险规则页都是叠层（MobileStackPage）：盖在上一层上面而不是替换它，
  // 所以上一层的滚动位置天然保留，侧滑返回时页面缩成卡片、露出真实的上一层。
  const homeRef = useRef<HTMLDivElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);
  // 退出动画期间 activeCategory 已经是 null，页面还要照常显示离开的那一页。
  const lastCategoryRef = useRef<MobileSettingsCategoryId | null>(null);
  if (activeCategory) lastCategoryRef.current = activeCategory;
  const shownCategory = activeCategory ?? lastCategoryRef.current;

  // 返回设置首页（侧滑返回与页头「返回设置」同一条路径，含主题试用的预览清理）。
  const closeCategory = useCallback(() => {
    storeClearPreview();
    setActiveCategory(null);
  }, [storeClearPreview]);

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
      <div className="flex h-full items-center justify-center text-body text-fg-secondary">
        加载设置中…
      </div>
    );
  }

  const shownMeta = shownCategory
    ? MOBILE_SETTINGS_CATEGORIES.find((c) => c.id === shownCategory)
    : null;

  const saveErrorBanner = saveError ? (
    <div className="flex-shrink-0 border-b border-red-900/40 bg-red-950/30 px-3 py-1.5 text-meta text-red-300">
      {saveError}
    </div>
  ) : null;

  return (
    <SettingsActionsProvider value={actionsValue}>
      <div className="relative h-full min-h-0 overflow-hidden bg-surface-sunken">
        <div ref={homeRef} className="absolute inset-0 flex min-h-0 flex-col bg-surface-sunken">
          <SettingsHeader title="设置" description="模型、Agent、工具与同步" />
          {saveErrorBanner}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <nav className="flex flex-col p-3">
              {groupSettingsPages(MOBILE_SETTINGS_CATEGORIES).map(({ group, pages }) => (
                <div key={group.id} className="flex flex-col gap-2 [&:not(:first-child)]:mt-6">
                  {group.title && (
                    <div className="px-4 text-meta text-fg-tertiary">{group.title}</div>
                  )}
                  <div className="overflow-hidden rounded-xl bg-surface-raised">
                    {pages.map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setActiveCategory(cat.id)}
                        className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-state-mid [&:not(:first-child)]:border-t [&:not(:first-child)]:border-edge-subtle"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-body font-medium text-fg">
                            {cat.title}
                            {cat.id === 'sync' && needsAttention(syncState) && (
                              <>
                                <StatusDot tone={syncState === 'error' ? 'error' : 'warn'} />
                                <span className="sr-only">需要处理</span>
                              </>
                            )}
                          </div>
                          <div className="mt-0.5 text-meta text-fg-tertiary">
                            {cat.description}
                          </div>
                        </div>
                        <ChevronRight size={16} strokeWidth={1.5} className="flex-shrink-0 text-fg-disabled" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        </div>

        <MobileStackPage
          open={activeCategory != null}
          onBack={closeCategory}
          underlay={() => homeRef.current}
          backEnabled={visible}
        >
          <div ref={categoryRef} className="absolute inset-0 flex min-h-0 flex-col">
            <SettingsHeader
              backLabel="返回设置"
              onBack={closeCategory}
              title={shownMeta?.title ?? '设置'}
              description={shownMeta?.description}
            />
            {saveErrorBanner}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              {shownCategory === 'appearance' && <MobileAppearancePage />}
              {shownCategory === 'model' && <MobileModelSection />}
              {shownCategory === 'agent' && <MobileAgentPolicySection />}
              {shownCategory === 'tools' && <MobileToolsPage />}
              {shownCategory === 'memory' && <MobileMemorySection />}
              {shownCategory === 'notification' && <MobileNotificationBackgroundSection />}
              {shownCategory === 'sync' && <MobileSyncSection />}
              {shownCategory === 'about' && (
                <MobileAboutSection onOpenDebug={() => setDebugOpen(true)} />
              )}
            </div>
          </div>

          {shownCategory === 'agent' && (
            <MobileStackPage
              open={showRulesPage}
              onBack={closeRulesPage}
              underlay={() => categoryRef.current}
              backEnabled={visible}
            >
              <SettingsHeader backLabel="返回 Agent" onBack={closeRulesPage} title="内置风险规则" />
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                <RiskRulesPage compact />
              </div>
            </MobileStackPage>
          )}
        </MobileStackPage>
      </div>
      {/* 一直渲染、用 open 开合：外壳要留着页面把收回动画播完，条件渲染会让它一关就消失。 */}
      <MobileFullscreenPage
        region="mobile-debug"
        open={debugOpen && visible}
        onBack={() => setDebugOpen(false)}
      >
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
    </SettingsActionsProvider>
  );
}

/** Page header shared by the settings home, category pages and the risk-rules page. */
function SettingsHeader({
  title,
  description,
  backLabel,
  onBack,
}: {
  title: string;
  description?: string;
  backLabel?: string;
  onBack?: () => void;
}) {
  return (
    <header
      className="flex-shrink-0 border-b border-edge-subtle px-3 py-3"
      style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))' }}
    >
      {backLabel && onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="mb-1 flex min-h-11 items-center gap-1 text-body text-indigo-400 transition-colors active:text-indigo-300"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {backLabel}
        </button>
      ) : null}
      <h1 className="flex items-center gap-2 text-title font-semibold text-fg">{title}</h1>
      {description ? <p className="mt-0.5 text-meta text-fg-tertiary">{description}</p> : null}
    </header>
  );
}
