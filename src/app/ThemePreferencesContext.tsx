import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppearanceMode, ChatPanelState, LocaleName, PaletteName, ThemePreferences } from '../domain/contracts';
import { useAppServices } from './AppServicesContext';

interface ThemeContextValue {
  preferences: ThemePreferences;
  effectiveMode: 'light' | 'dark';
  setPalette: (palette: PaletteName) => void;
  setAppearance: (appearance: AppearanceMode) => void;
  setLocale: (locale: LocaleName) => void;
  setChatPanel: (state: ChatPanelState) => void;
  resetTheme: () => void;
}

const ThemePreferencesContext = createContext<ThemeContextValue | null>(null);

export function ThemePreferencesProvider({ children }: { children: ReactNode }) {
  const services = useAppServices();
  const [preferences, setPreferences] = useState(() => services.settings.get());
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const effectiveMode = preferences.appearance === 'system' ? (systemDark ? 'dark' : 'light') : preferences.appearance;

  useEffect(() => {
    document.documentElement.dataset.palette = preferences.palette;
    document.documentElement.dataset.appearance = effectiveMode;
    document.documentElement.dataset.mode = effectiveMode;
  }, [effectiveMode, preferences.palette]);

  const update = useCallback((next: ThemePreferences) => {
    services.settings.save(next);
    setPreferences(next);
  }, [services]);

  const value = useMemo<ThemeContextValue>(() => ({
    preferences,
    effectiveMode,
    setPalette: (palette) => update({ ...preferences, palette }),
    setAppearance: (appearance) => update({ ...preferences, appearance }),
    setLocale: (locale) => update({ ...preferences, locale }),
    setChatPanel: (chatPanel) => update({ ...preferences, chatPanel }),
    resetTheme: () => update({
      ...preferences,
      palette: 'sky',
      locale: 'en',
    }),
  }), [effectiveMode, preferences, update]);

  return <ThemePreferencesContext.Provider value={value}>{children}</ThemePreferencesContext.Provider>;
}

export function useThemePreferences() {
  const value = useContext(ThemePreferencesContext);
  if (!value) throw new Error('ThemePreferencesProvider is missing');
  return value;
}
