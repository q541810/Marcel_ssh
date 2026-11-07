import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { SettingsLayout } from '@/lib/settingsLayout';
import { resolveSettingsLayout } from '@/lib/settingsLayout';

// ───── Search Registry ─────

export interface SearchItem {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  sectionId: string;
}

interface SearchRegistryContextValue {
  items: SearchItem[];
  register: (item: SearchItem) => void;
  unregister: (id: string) => void;
}

const SearchRegistryContext = createContext<SearchRegistryContextValue | null>(null);

export function SearchRegistryProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<SearchItem[]>([]);

  const register = useCallback((item: SearchItem) => {
    setItems((prev) => {
      const filtered = prev.filter((i) => i.id !== item.id);
      return [...filtered, item];
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const value = useMemo(() => ({ items, register, unregister }), [items, register, unregister]);

  return (
    <SearchRegistryContext.Provider value={value}>
      {children}
    </SearchRegistryContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSearchRegistry() {
  const ctx = useContext(SearchRegistryContext);
  if (!ctx) throw new Error('useSearchRegistry must be used within SearchRegistryProvider');
  return ctx;
}

// ───── Settings Layout ─────

const SettingsLayoutContext = createContext<SettingsLayout>(resolveSettingsLayout(1200));

export function SettingsLayoutProvider({
  layout,
  children,
}: {
  layout: SettingsLayout;
  children: React.ReactNode;
}) {
  return <SettingsLayoutContext.Provider value={layout}>{children}</SettingsLayoutContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettingsLayout() {
  return useContext(SettingsLayoutContext);
}

// ───── New UI Components ─────

export function Card({
  id,
  title,
  badge,
  description,
  children,
}: {
  id?: string;
  title: string;
  /** 标题后面的小标（「Beta」之类）。 */
  badge?: React.ReactNode;
  description?: string;
  children: React.ReactNode;
}) {
  const layout = useSettingsLayout();

  return (
    <div id={id}>
      <div className={`settings-card-header px-1 pb-3`}>
        <h3 className="flex items-center gap-2 text-title text-fg">
          {title}
          {badge}
        </h3>
        {description && <p className="text-meta text-fg-secondary mt-1">{description}</p>}
      </div>
      {/* 不能 overflow-hidden：卡片里最后一项的下拉列表会被卡片边缘裁掉。圆角改由首尾子元素自己带。 */}
      <div className="rounded-xl bg-surface-raised divide-y divide-edge-subtle [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl">
        {children}
      </div>
    </div>
  );
}

export function SettingItem({
  id,
  label,
  description,
  keywords,
  children,
  sectionId,
  density = 'default',
}: {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  children: React.ReactNode;
  sectionId: string;
  density?: 'default' | 'compact';
}) {
  const { register, unregister } = useSearchRegistry();
  const layout = useSettingsLayout();
  const keywordsKey = keywords ? JSON.stringify(keywords) : '';

  useEffect(() => {
    register({ id, label, description, keywords, sectionId });
    return () => unregister(id);
  }, [id, label, description, keywordsKey, sectionId, register, unregister]);

  const compact = density === 'compact';
  const stacked = layout.itemLayout === 'stacked' && !compact;

  return (
    <div
      className={`settings-item ${compact ? 'px-4 py-3 items-center' : 'px-4 py-3 items-start'} ${
        stacked ? 'flex flex-col gap-3' : 'flex gap-6'
      }`}
    >
      <div
        className={`settings-label-column ${compact || stacked ? 'min-w-0' : 'flex-shrink-0'}`}
        style={!compact && !stacked ? { width: `${layout.labelWidth}px` } : undefined}
      >
        <div className={`text-body text-fg`}>{label}</div>
        {description && (
          <div className={`text-meta text-fg-secondary mt-1`}>
            {description}
          </div>
        )}
      </div>
      <div className={`${compact ? 'flex-shrink-0' : 'flex-1 min-w-0'}`}>{children}</div>
    </div>
  );
}

// ───── Legacy Components (deprecated, kept for backward compatibility) ─────

export function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-8 scroll-mt-8">
      <h2 className="text-title text-fg mb-1">{title}</h2>
      {description && <p className="text-meta text-fg-tertiary mb-3">{description}</p>}
      <div className="space-y-3 mt-3">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
  alignTop,
}: {
  label: string;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div className={`flex gap-4 ${alignTop ? 'items-start' : 'items-center'}`}>
      <label className={`w-32 flex-shrink-0 text-body text-fg-secondary ${alignTop ? 'pt-2' : ''}`}>
        {label}
      </label>
      <div className="flex-1 flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}
