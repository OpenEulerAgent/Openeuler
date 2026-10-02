"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { TokenGate } from "@/components/auth/TokenGate";

// The palette is only needed on ⌘K — keep it out of the first-load bundle.
const CommandPalette = dynamic(() => import("./CommandPalette").then((mod) => mod.CommandPalette), {
  ssr: false,
});

/**
 * App shell (issue #50): collapsible left sidebar + top bar (project context,
 * daemon health, running-runs indicator) wrapping every page. Also owns the
 * global ⌘K hotkey for the command palette.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = usePathname();

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[80] focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-sm focus:text-accent-fg"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={openPalette} />
        <main
          id="main-content"
          className={cn(
            "mx-auto w-full flex-1",
            // The graph canvas wants the full viewport width and height.
            isCanvasEditorRoute(pathname)
              ? "max-w-none px-0 py-0"
              : "max-w-6xl px-4 py-6 md:px-6 md:py-8",
          )}
        >
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      {/* 401 token gate (#92): opens itself when the daemon rejects a request. */}
      <TokenGate />
    </div>
  );
}

/** Routes that get the full-bleed layout (the graph canvas editor, #46). */
export function isCanvasEditorRoute(pathname: string): boolean {
  return /^\/projects\/[^/]+\/workflows\/[^/]+\/edit$/.test(pathname);
}
