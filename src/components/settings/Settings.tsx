import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginStore } from '@/stores/pluginStore';
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

  useEffect(() => {
    return () => {
      clearTimeout(savedNoticeTimerRef.current);
      clearTimeout(saveErrorTimerRef.current);
    };
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

  useEffect(() => {
    if (loaded && draft === null) {
      setDraft(storeSettings);
    }
  }, [loaded, draft, storeSettings]);

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
          <div ref={shellRef} className="settings-shell flex flex-1 h-full min-w-0">
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
