import { useEffect, useRef } from 'react';
import { AlertCircle, Check, Loader2, Save, Search, Undo2 } from 'lucide-react';
import Button from '@/components/ui/Button';
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
      className="settings-sidebar flex-shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col"
      style={{ width: `${layout.sidebarWidth}px` }}
    >
      <div className={`settings-sidebar-padding ${layout.mode === 'wide' ? 'p-5' : 'p-4'}`}>
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
        {SETTINGS_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => {
              onChange(cat.id);
              onSearchChange('');
            }}
            className={`w-full flex items-center gap-3 px-3 ${layout.mode === 'wide' ? 'py-2.5' : 'py-2'} rounded-lg text-sm transition-colors ${
              activeCategory === cat.id && !searchQuery
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            }`}
          >
            {cat.icon}
            <span className="truncate">{cat.label}</span>
          </button>
        ))}
      </nav>
      {!searchQuery && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-2">
          {(saving || savedNotice || saveError || dirty) && (
            <div className="text-xs">
              {saving && (
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  保存中...
                </div>
              )}
              {savedNotice && (
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <Check className="w-3 h-3" />
                  {savedNotice}
                </div>
              )}
              {saveError && (
                <div className="flex items-center gap-1.5 text-red-400">
                  <AlertCircle className="w-3 h-3" />
                  {saveError}
                </div>
              )}
              {!saving && !savedNotice && !saveError && dirty && (
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
              className={`flex-1 ${dirty ? '' : 'opacity-50 cursor-not-allowed'}`}
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
