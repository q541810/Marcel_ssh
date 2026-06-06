import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { getErrorMessage } from '@/lib/errors';
import type { AppSettings } from '@/lib/types';
import { SearchRegistryProvider } from './helpers';
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

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        加载设置中...
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(storeSettings);

  const handleSave = async () => {
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
      <SettingsActionsProvider value={{ settings: draft, update: updateDraft, setPreview, saving, saveError }}>
        <div className="flex h-full">
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
    </SearchRegistryProvider>
  );
}
