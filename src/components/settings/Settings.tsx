import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { getErrorMessage } from '@/lib/errors';
import { Search, Sliders, Bot, Info, Save, Undo2, Loader2, Check, AlertCircle } from 'lucide-react';
import type { AppSettings } from '@/lib/types';
import Button from '@/components/ui/Button';
import { SearchRegistryProvider, useSearchRegistry } from './helpers';
import { SettingsActionsProvider } from './SettingsActionsContext';
import { AppearanceSection } from './AppearanceSection';
import { DisplaySection } from './DisplaySection';
import { LlmSection } from './LlmSection';
import { CommandPolicySection } from './CommandPolicySection';
import { ExperimentalSection } from './ExperimentalSection';
import AboutSection from './AboutSection';

interface Category {
  id: string;
  label: string;
  icon: React.ReactNode;
  sections: string[];
}

const CATEGORIES: Category[] = [
  {
    id: 'general',
    label: '通用',
    icon: <Sliders className="w-4 h-4" />,
    sections: ['settings-appearance', 'settings-display'],
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: <Bot className="w-4 h-4" />,
    sections: ['settings-llm', 'settings-command-policy', 'settings-experimental'],
  },
  {
    id: 'about',
    label: '关于',
    icon: <Info className="w-4 h-4" />,
    sections: ['settings-about'],
  },
];

const CATEGORY_SECTIONS: Record<string, string[]> = {
  general: ['settings-appearance', 'settings-display'],
  agent: ['settings-llm', 'settings-command-policy', 'settings-experimental'],
  about: ['settings-about'],
};

/* ───── Left Sidebar ───── */

function LeftSidebar({
  activeCategory,
  onChange,
  searchQuery,
  onSearchChange,
}: {
  activeCategory: string;
  onChange: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="w-64 flex-shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col">
      <div className="p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Ctrl+F 搜索"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>
      <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => {
              onChange(cat.id);
              onSearchChange('');
            }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              activeCategory === cat.id && !searchQuery
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            {cat.icon}
            <span>{cat.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ───── Content Area ───── */

function SettingsContent({
  activeCategory,
  searchQuery,
  dirty,
  saving,
  saveError,
  savedNotice,
  onSave,
  onReset,
}: {
  activeCategory: string;
  searchQuery: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  savedNotice: string | null;
  onSave: () => void;
  onReset: () => void;
}) {
  const { items } = useSearchRegistry();

  const visibleSections = useMemo(() => {
    if (!searchQuery.trim()) {
      return CATEGORY_SECTIONS[activeCategory] || [];
    }

    const query = searchQuery.toLowerCase();
    const matching = new Set<string>();

    for (const item of items) {
      const text = `${item.label} ${item.description || ''} ${(item.keywords || []).join(' ')}`.toLowerCase();
      if (text.includes(query)) {
        matching.add(item.sectionId);
      }
    }

    return Array.from(matching);
  }, [activeCategory, searchQuery, items]);

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-900">
      <div className="max-w-3xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-zinc-100">
            {isSearching ? `搜索：${searchQuery}` : CATEGORIES.find((c) => c.id === activeCategory)?.label}
          </h1>
          {!isSearching && (
            <div className="flex items-center gap-3">
              {saving && (
                <div className="flex items-center gap-1.5 text-sm text-zinc-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  保存中...
                </div>
              )}
              {savedNotice && (
                <div className="flex items-center gap-1.5 text-sm text-emerald-400">
                  <Check className="w-4 h-4" />
                  {savedNotice}
                </div>
              )}
              {saveError && (
                <div className="flex items-center gap-1.5 text-sm text-red-400">
                  <AlertCircle className="w-4 h-4" />
                  {saveError}
                </div>
              )}
              {dirty && !saving && !savedNotice && (
                <span className="text-xs text-amber-400">有未保存的更改</span>
              )}
              {dirty && (
                <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
                  <Undo2 className="w-3.5 h-3.5" />
                  撤销
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={onSave} disabled={!dirty} loading={saving}>
                <Save className="w-3.5 h-3.5" />
                保存
              </Button>
            </div>
          )}
        </div>

        {/* Sections */}
        {visibleSections.length === 0 && isSearching && (
          <div className="text-zinc-500 text-center py-12">未找到匹配的设置项</div>
        )}

        {visibleSections.includes('settings-appearance') && <AppearanceSection />}
        {visibleSections.includes('settings-display') && <DisplaySection />}
        {visibleSections.includes('settings-llm') && <LlmSection />}
        {visibleSections.includes('settings-command-policy') && <CommandPolicySection />}
        {visibleSections.includes('settings-experimental') && <ExperimentalSection />}
        {visibleSections.includes('settings-about') && <AboutSection />}
      </div>
    </div>
  );
}

/* ───── Main Settings Component ───── */

export default function Settings() {
  const storeSettings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const storeSave = useSettingsStore((s) => s.save);
  const storeSetPreview = useSettingsStore((s) => s.setPreview);
  const storeClearPreview = useSettingsStore((s) => s.clearPreview);

  const [activeCategory, setActiveCategory] = useState('general');
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
    if (!draft) return;
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
          <LeftSidebar
            activeCategory={activeCategory}
            onChange={setActiveCategory}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />
          <SettingsContent
            activeCategory={activeCategory}
            searchQuery={searchQuery}
            dirty={dirty}
            saving={saving}
            saveError={saveError}
            savedNotice={savedNotice}
            onSave={handleSave}
            onReset={handleReset}
          />
        </div>
      </SettingsActionsProvider>
    </SearchRegistryProvider>
  );
}
