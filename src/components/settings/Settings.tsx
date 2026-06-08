import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { getErrorMessage } from '@/lib/errors';
import type { AppSettings } from '@/lib/types';
import { resolveSettingsLayout } from '@/lib/settingsLayout';
import { SearchRegistryProvider, SettingsLayoutProvider } from './helpers';
import { SettingsActionsProvider } from './SettingsActionsContext';
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
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(1200);

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
  }, [draft]);

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        加载设置中...
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(storeSettings);
  const layout = resolveSettingsLayout(shellWidth);

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      await storeSave(draft);
      setSavedNotice('已保存');
      setTimeout(() => setSavedNotice(null), 2000);
    } catch (err) {
      setSaveError(getErrorMessage(err));
      setTimeout(() => setSaveError(null), 3000);
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
        <SettingsActionsProvider value={{ settings: draft, update: updateDraft, setPreview, saving, saveError }}>
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
