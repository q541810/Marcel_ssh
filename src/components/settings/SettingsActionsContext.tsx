import { createContext, useContext, useCallback, useRef } from 'react';
import type { AppSettings } from '@/lib/types';

export type ValidatorFn = (draft: AppSettings) => string | null;

interface SettingsActionsContextValue {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  setPreview: (preview: Partial<AppSettings>) => void;
  saving: boolean;
  saveError: string | null;
  validationErrors: string[];
  registerValidator: (id: string, fn: ValidatorFn) => () => void;
  clearValidationErrors: () => void;
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

export function useValidators() {
  const validatorsRef = useRef<Map<string, ValidatorFn>>(new Map());

  const registerValidator = useCallback((id: string, fn: ValidatorFn) => {
    validatorsRef.current.set(id, fn);
    return () => {
      validatorsRef.current.delete(id);
    };
  }, []);

  const runValidators = useCallback((draft: AppSettings): string[] => {
    const errors: string[] = [];
    for (const [, fn] of validatorsRef.current) {
      const err = fn(draft);
      if (err) errors.push(err);
    }
    return errors;
  }, []);

  return { registerValidator, runValidators };
}
