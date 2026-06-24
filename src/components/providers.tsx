"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { LOCALES, type Locale, translate } from "@/lib/i18n";

type Theme = "dark" | "light";

interface Ctx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const AppContext = createContext<Ctx | null>(null);

const THEME_KEY = "fb_theme";
const LOCALE_KEY = "fb_locale";

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(theme);
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Sync React state to the persisted theme/locale on mount (the no-flash script already set the
  // class pre-paint). Dark is the default.
  const [theme, setThemeState] = useState<Theme>("dark");
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const savedTheme = (localStorage.getItem(THEME_KEY) as Theme | null) ?? "dark";
    setThemeState(savedTheme);
    applyTheme(savedTheme);
    const savedLocale = localStorage.getItem(LOCALE_KEY) as Locale | null;
    if (savedLocale && LOCALES.includes(savedLocale)) setLocaleState(savedLocale);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme]
  );

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(LOCALE_KEY, l);
    document.documentElement.lang = l;
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  );

  return (
    <AppContext.Provider value={{ theme, setTheme, toggleTheme, locale, setLocale, t }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within Providers");
  return ctx;
}

/** Convenience hook for just translation. */
export function useT() {
  return useApp().t;
}
