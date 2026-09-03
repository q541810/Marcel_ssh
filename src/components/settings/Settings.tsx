import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsNavStore } from '@/stores/settingsNavStore';
import { getErrorMessage } from '@/lib/errors';
import type { AppSettings } from '@/lib/types';
import { resolveSettingsLayout } from '@/lib/settingsLayout';
import { SearchRegistryProvider, SettingsLayoutProvider } from './helpers';
import { SettingsActionsProvider } from './SettingsActionsContext';
import { useValidators } from './SettingsActionsContext';
import { SettingsContent } from './SettingsContent';
import { SettingsSidebar } from './SettingsSidebar';

export default function Settings() {
  const storeSettings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const storeSave = useSettingsStore((s) => s.save);
  const storeSetPreview = useSettingsStore((s) => s.setPreview);
  const storeClearPreview = useSettingsStore((s) => s.clearPreview);

  const [activeCategory, setActiveCategory] = useState('interface');
  const [searchQuery, setSearchQuery] = useState('');
  const [draft, setDraft] = useState<AppSettings | null>(() => {
    const state = useSettingsStore.getState();
    return state.loaded ? state.settings : null;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const shellRef = useRef<HTMLDivElement>(null);
  const { registerValidator, runValidators } = useValidators();
  const [shellWidth, setShellWidth] = useState(1200);
  const savedNoticeTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const saveErrorTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** 上次已同步进 draft 的 store 快照；用于区分「用户本地改动」与「外部 store 刷新」 */
  const lastSyncedStoreRef = useRef<AppSettings | null>(
    useSettingsStore.getState().loaded ? useSettingsStore.getState().settings : null,
  );

  useEffect(() => {
    return () => {
      clearTimeout(savedNoticeTimerRef.current);
      clearTimeout(saveErrorTimerRef.current);
    };
  }, []);

  // 消费外部发起的 category 跳转意图（点击后跳转到设置页某个分类）。
  // 单次消费：读到立即清空，避免残留影响后续手动切换。
  useEffect(() => {
    const pending = useSettingsNavStore.getState().consume();
    if (pending) setActiveCategory(pending);
    // 订阅后续请求：用 subscribe 捕获 store 内 pendingCategory 变化。
    const unsub = useSettingsNavStore.subscribe((s) => {
      if (s.pendingCategory) {
        setActiveCategory(s.pendingCategory);
        useSettingsNavStore.getState().consume();
      }
    });
    return unsub;
  }, []);

  const updateDraft = useCallback((patch: Partial<AppSettings>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const setPreview = useCallback(
    (preview: Partial<AppSettings>) => {
      storeSetPreview(preview);
    },
    [storeSetPreview]
  );

  // storeSettings 变化：初次加载 / 外部刷新 store。
  // layout 阶段跟进，避免 paint 一帧 draft 落后 → 闪「未保存的更改」。
  // 字段级跟进：用户未改过的顶层字段跟进刷新，改过的保留（避免外部覆盖本地编辑）。
  useLayoutEffect(() => {
    if (!loaded) return;
    const prevStore = lastSyncedStoreRef.current;
    lastSyncedStoreRef.current = storeSettings;
    setDraft((current) => {
      if (current === null) return storeSettings;
      if (prevStore === null) return storeSettings;
      // 整对象相同：直接跟进
      if (JSON.stringify(current) === JSON.stringify(prevStore)) {
        return storeSettings;
      }
      // 字段级合并：未改的顶层字段跟进 sync，改过的保留
      // 用 Record<string, unknown> 中间层规避 keyof 联合类型索引赋值的 TS 限制
      const cur = current as unknown as Record<string, unknown>;
      const prev = prevStore as unknown as Record<string, unknown>;
      const next = storeSettings as unknown as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...cur };
      for (const key of Object.keys(storeSettings)) {
        if (JSON.stringify(cur[key]) === JSON.stringify(prev[key])) {
          merged[key] = next[key];
        }
      }
      return merged as unknown as AppSettings;
    });
  }, [loaded, storeSettings]);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      setShellWidth((current) => (current === width ? current : width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => resolveSettingsLayout(shellWidth), [shellWidth]);

  const dirty = useMemo(
    () => (draft ? JSON.stringify(draft) !== JSON.stringify(storeSettings) : false),
    [draft, storeSettings]
  );

  const clearValidationErrors = useCallback(() => setValidationErrors([]), []);

  const actionsValue = useMemo(
    () => (draft ? { settings: draft, update: updateDraft, setPreview, saving, saveError, validationErrors, registerValidator, clearValidationErrors } : null),
    [draft, updateDraft, setPreview, saving, saveError, validationErrors, registerValidator, clearValidationErrors]
  );

  if (!loaded || !draft || !actionsValue) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        加载设置中...
      </div>
    );
  }

  // 需要值校验的输入框请使用 ValidatedInput 组件（自动注册保存时校验 + 值合法时清除 context 错误）
  // 用法：import { ValidatedInput } from './ValidatedInput';
  const handleSave = async () => {
    if (saving) return;
    if (!dirty && validationErrors.length === 0) return;
    setSaveError(null);
    setSavedNotice(null);
    setValidationErrors([]);
    const errors = runValidators(draft);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    setSaving(true);
    try {
      await storeSave(draft);
      setSavedNotice('已保存');
      clearTimeout(savedNoticeTimerRef.current);
      savedNoticeTimerRef.current = setTimeout(() => setSavedNotice(null), 2000);
      usePluginStore.getState().fetchPlugins().catch((err) => {
        console.error('保存后刷新插件失败:', err);
      });
    } catch (err) {
      setSaveError(getErrorMessage(err));
      clearTimeout(saveErrorTimerRef.current);
      saveErrorTimerRef.current = setTimeout(() => setSaveError(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(storeSettings);
    storeClearPreview();
  };

  return (
    <SearchRegistryProvider>
      <SettingsLayoutProvider layout={layout}>
        <SettingsActionsProvider value={actionsValue}>
          <div ref={shellRef} data-region="settings" className="settings-shell flex flex-1 h-full min-w-0">
            <SettingsSidebar
              activeCategory={activeCategory}
              onChange={setActiveCategory}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              dirty={dirty}
              saving={saving}
              saveError={saveError}
              savedNotice={savedNotice}
              validationErrors={validationErrors}
              onSave={handleSave}
              onReset={handleReset}
            />
            <SettingsContent activeCategory={activeCategory} searchQuery={searchQuery} />
          </div>
        </SettingsActionsProvider>
      </SettingsLayoutProvider>
    </SearchRegistryProvider>
  );
}
