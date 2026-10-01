"use client";

import { useEffect, useState } from "react";
import {
  applySidebarPreference,
  persistSidebar,
  resolveSidebarPreference,
  type SidebarPreference,
} from "@/lib/sidebar";

/**
 * Hook version of the sidebar preference (lib/sidebar.ts stays React-free so
 * the server layout can import the init script): mirrors the pre-paint
 * `data-sidebar` attribute the init script applied — never a hydration
 * mismatch — and keeps it in sync on toggle.
 */
export function useSidebarPreference(): [SidebarPreference, (next: SidebarPreference) => void] {
  const [pref, setPrefState] = useState<SidebarPreference>("expanded");

  useEffect(() => {
    setPrefState(resolveSidebarPreference(document.documentElement.dataset.sidebar ?? null));
  }, []);

  const setPref = (next: SidebarPreference): void => {
    setPrefState(next);
    applySidebarPreference(document, next);
    persistSidebar(window.localStorage, next);
  };

  return [pref, setPref];
}
