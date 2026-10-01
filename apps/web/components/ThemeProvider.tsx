"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { applyTheme, persistTheme, resolveTheme, type Theme } from "@/lib/theme";

/**
 * Theme context so any client component can read/toggle the theme without
 * each of them opening their own localStorage handle (issue #50). The hook
 * version of the same logic lives here (not in lib/theme.ts) so the root
 * layout can keep importing the init script from a React-free module.
 */

function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("dark");

  // Initial render assumes the SSR default (dark); sync to whatever the
  // pre-paint inline script applied — never a hydration mismatch.
  useEffect(() => {
    setThemeState(resolveTheme(document.documentElement.dataset.theme ?? null));
  }, []);

  const setTheme = (next: Theme): void => {
    setThemeState(next);
    applyTheme(document, next);
    persistTheme(window.localStorage, next);
  };

  return [theme, setTheme];
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useThemeContext must be used within <ThemeProvider>");
  return context;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useTheme();
  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
