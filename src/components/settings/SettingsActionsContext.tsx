import { createContext, useContext } from 'react';
import type { AppSettings } from '@/lib/types';

interface SettingsActionsContextValue {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  setPreview: (preview: Partial<AppSettings>) => void;
  saving: boolean;
  saveError: string | null;
}

const SettingsActionsContext = createContext<SettingsActionsContextValue | null>(null);

export function SettingsActionsProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: SettingsActionsContextValue;
}) {
  return (
    <SettingsActionsContext.Provider value={value}>
      {children}
    </SettingsActionsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettingsActions() {
  const ctx = useContext(SettingsActionsContext);
  if (!ctx) throw new Error('useSettingsActions must be used within SettingsActionsProvider');
  return ctx;
}
