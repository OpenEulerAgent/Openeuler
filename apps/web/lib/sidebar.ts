/**
 * Sidebar collapse persistence (issue #50): the collapsed/expanded choice is
 * stored under {@link SIDEBAR_STORAGE_KEY} and restored on load. Expanded is
 * the default; invalid values fall back to it. Like the theme, the choice is
 * re-applied before first paint by {@link SIDEBAR_INIT_SCRIPT} (inlined into
 * <head> by the root layout) writing `data-sidebar` on <html>, which the
 * sidebar's CSS keys off — no flash of the expanded sidebar.
 *
 * Pure logic only (no React) so the server layout can import the init script
 * constant; the hook lives in components/shell/sidebar-preference.ts.
 */

export type SidebarPreference = "expanded" | "collapsed";

export const SIDEBAR_STORAGE_KEY = "openeuler-sidebar";

export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolveSidebarPreference(raw: string | null): SidebarPreference {
  return raw === "collapsed" ? "collapsed" : "expanded";
}

export function readStoredSidebar(storage: SidebarStorage): SidebarPreference {
  try {
    return resolveSidebarPreference(storage.getItem(SIDEBAR_STORAGE_KEY));
  } catch {
    return "expanded";
  }
}

export function persistSidebar(storage: SidebarStorage, pref: SidebarPreference): void {
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, pref);
  } catch {
    // Storage failures must never break the UI.
  }
}

export function toggleSidebarPreference(pref: SidebarPreference): SidebarPreference {
  return pref === "expanded" ? "collapsed" : "expanded";
}

/** Minimal document surface for testability (mirrors lib/theme.ts). */
export interface SidebarDocument {
  documentElement: { dataset: Record<string, string | undefined> };
}

export function applySidebarPreference(document: SidebarDocument, pref: SidebarPreference): void {
  document.documentElement.dataset.sidebar = pref;
}

/**
 * Inlined verbatim into <head> by the root layout: applies the persisted
 * sidebar preference to <html data-sidebar=…> before first paint so the
 * collapsed rail renders without an expanded flash (the Sidebar CSS keys off
 * the attribute; the hook only mirrors it for aria/behavior).
 */
export const SIDEBAR_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)});document.documentElement.dataset.sidebar=s==="collapsed"?"collapsed":"expanded";}catch(e){}})();`;
