/**
 * Sidebar collapse persistence (issue #50): the collapsed/expanded choice is
 * stored under {@link SIDEBAR_STORAGE_KEY} and restored on load. Expanded is
 * the default; invalid values fall back to it.
 */
import { useEffect, useState } from "react";

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

export function useSidebarPreference(): [SidebarPreference, (next: SidebarPreference) => void] {
  const [pref, setPrefState] = useState<SidebarPreference>("expanded");

  useEffect(() => {
    setPrefState(resolveSidebarPreference(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)));
  }, []);

  const setPref = (next: SidebarPreference): void => {
    setPrefState(next);
    persistSidebar(window.localStorage, next);
  };

  return [pref, setPref];
}
