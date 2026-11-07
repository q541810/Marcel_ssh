import { useEffect, useRef } from 'react';
import { AlertCircle, Check, Loader2, Save, Search, Undo2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { groupSettingsPages } from '@/lib/settingsCatalog';
import { SETTINGS_CATEGORIES } from './settingsNavigation';
import { useSettingsLayout } from './helpers';

interface SettingsSidebarProps {
  activeCategory: string;
  onChange: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  savedNotice: string | null;
  validationErrors: string[];
  onSave: () => void;
  onReset: () => void;
}

export function SettingsSidebar({
  activeCategory,
  onChange,
  searchQuery,
  onSearchChange,
  dirty,
  saving,
  saveError,
  savedNotice,
  validationErrors,
  onSave,
  onReset,
}: SettingsSidebarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const layout = useSettingsLayout();

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
    <div
      className="settings-sidebar flex-shrink-0 bg-surface-sunken border-r border-edge-subtle flex flex-col"
      style={{ width: `${layout.sidebarWidth}px` }}
    >
      <div className={`settings-sidebar-padding ${layout.mode === 'wide' ? 'p-5' : 'p-4'}`}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-tertiary" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Ctrl+F 搜索"
            className="w-full pl-9 pr-3 h-8 rounded-lg bg-surface border border-edge text-body text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>
      <nav className="flex-1 px-2 overflow-y-auto">
        {groupSettingsPages(SETTINGS_CATEGORIES).map(({ group, pages }) => (
          <div key={group.id} className="space-y-1 [&:not(:first-child)]:mt-3">
            {group.title && (
              <div className="px-3 pb-1 pt-1 text-caption font-medium tracking-wide text-fg-tertiary">
                {group.title}
              </div>
            )}
            {pages.map((cat) => (
              <button
                key={cat.id}
                onClick={() => {
                  onChange(cat.id);
                  onSearchChange('');
                }}
                className={`w-full flex items-center gap-3 px-3 h-8 rounded-lg text-body transition-colors pressable focus-ring ${
                  activeCategory === cat.id && !searchQuery
                    ? 'bg-state-selected text-fg'
                    : 'text-fg-secondary hover:bg-state-soft hover:text-fg'
                }`}
              >
                {cat.icon}
                <span className="truncate">{cat.title}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      {!searchQuery && (
        <div className="border-t border-edge-subtle px-4 py-3 space-y-2">
          {(saving || savedNotice || saveError || validationErrors.length > 0 || dirty) && (
            <div className="text-meta">
              {saving && (
                <div className="flex items-center gap-2 text-fg-secondary">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  保存中...
                </div>
              )}
              {savedNotice && (
                <div className="flex items-center gap-2 text-emerald-400">
                  <Check className="w-3 h-3" />
                  {savedNotice}
                </div>
              )}
              {saveError && (
                <div className="flex items-center gap-2 text-red-400">
                  <AlertCircle className="w-3 h-3" />
                  {saveError}
                </div>
              )}
              {validationErrors.length > 0 && (
                <div className="space-y-1">
                  {validationErrors.map((err, i) => (
                    <div key={i} className="flex items-start gap-2 text-red-400">
                      <AlertCircle className="w-3 h-3 mt-1 flex-shrink-0" />
                      <span>{err}</span>
                    </div>
                  ))}
                </div>
              )}
              {!saving && !savedNotice && !saveError && validationErrors.length === 0 && dirty && (
                <span className="text-amber-400">有未保存的更改</span>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" className="flex-1" onClick={onReset} disabled={saving}>
                <Undo2 className="w-3.5 h-3.5" />
                撤销
              </Button>
            )}
            <Button
              variant="primary"
              className={`flex-1 ${dirty || validationErrors.length > 0 ? '' : 'opacity-50 cursor-not-allowed'}`}
              onClick={onSave}
              disabled={saving}
              loading={saving}
            >
              <Save className="w-4 h-4" />
              保存
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
