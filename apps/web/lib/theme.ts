/**
 * Theme switching (issue #50). Dark is the default; light is opt-in via
 * `data-theme="light"` on `<html>`. The choice persists to localStorage under
 * {@link THEME_STORAGE_KEY} and is re-applied before first paint by
 * {@link THEME_INIT_SCRIPT} (inlined into <head> by the root layout).
 *
 * Pure logic only (no React) so the server layout can import the init script
 * constant; the hook lives in components/ThemeProvider.tsx.
 */

export type Theme = "dark" | "light";

export const THEMES: readonly Theme[] = ["dark", "light"];

export const THEME_STORAGE_KEY = "openeuler-theme";

/** Parse a stored value into a Theme; anything unknown falls back to dark. */
export function resolveTheme(raw: string | null): Theme {
  return raw === "light" ? "light" : "dark";
}

/** Minimal storage surface (localStorage-compatible) for testability. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredTheme(storage: ThemeStorage): Theme {
  try {
    return resolveTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function persistTheme(storage: ThemeStorage, theme: Theme): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-browsing/quota failures must never break the UI.
  }
}

/** Minimal document surface for testability. */
export interface ThemeDocument {
  documentElement: { dataset: Record<string, string | undefined> };
}

export function applyTheme(document: ThemeDocument, theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function toggleTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/**
 * Inlined verbatim into <head> by the root layout: applies the persisted
 * theme to <html> before first paint so there is no flash of the wrong theme.
 * Must stay dependency-free and IE-safe enough for a modern evergreen only.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var e=t==="light"?"light":"dark";document.documentElement.dataset.theme=e;}catch(e){}})();`;
