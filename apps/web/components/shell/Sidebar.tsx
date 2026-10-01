"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BoxIcon, DashboardIcon, FolderIcon, PanelLeftIcon, PlayIcon, SlidersIcon } from "./icons";
import { toggleSidebarPreference, useSidebarPreference } from "@/lib/sidebar";
import { cn } from "@/lib/cn";

export const NAV_LINKS = [
  { href: "/", label: "Dashboard", Icon: DashboardIcon },
  { href: "/projects", label: "Projects", Icon: FolderIcon },
  { href: "/runs", label: "Runs", Icon: PlayIcon },
  { href: "/settings", label: "Settings", Icon: SlidersIcon },
] as const;

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Left app-shell sidebar (issue #50): primary nav, collapsible to an icon
 * rail. The collapse choice persists to localStorage (useSidebarPreference)
 * and the toggle stays keyboard accessible with aria-expanded/aria-controls.
 */
export function Sidebar() {
  const pathname = usePathname();
  const [pref, setPref] = useSidebarPreference();
  const collapsed = pref === "collapsed";

  return (
    <aside
      id="app-sidebar"
      aria-label="Sidebar"
      className={cn(
        "sticky top-0 flex h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-border",
          collapsed ? "justify-center px-2" : "justify-between px-3",
        )}
      >
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md px-1 py-1 font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Openeuler home"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <BoxIcon className="size-4" />
          </span>
          {collapsed ? null : <span className="text-sm">Openeuler</span>}
        </Link>
        {!collapsed ? (
          <button
            type="button"
            onClick={() => setPref(toggleSidebarPreference(pref))}
            aria-label="Collapse sidebar"
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            title="Collapse sidebar"
            className="rounded-md p-1.5 text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <PanelLeftIcon className="size-4" />
          </button>
        ) : null}
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col gap-1 p-2">
        {NAV_LINKS.map(({ href, label, Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              title={collapsed ? label : undefined}
              aria-label={collapsed ? label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                collapsed && "justify-center",
                active
                  ? "bg-accent text-accent-fg"
                  : "text-muted-fg hover:bg-elevated hover:text-fg",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {collapsed ? null : <span>{label}</span>}
            </Link>
          );
        })}
      </nav>

      {collapsed ? (
        <div className="flex justify-center border-t border-border p-2">
          <button
            type="button"
            onClick={() => setPref(toggleSidebarPreference(pref))}
            aria-label="Expand sidebar"
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            title="Expand sidebar"
            className="rounded-md p-1.5 text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <PanelLeftIcon className="size-4 rotate-180" />
          </button>
        </div>
      ) : null}
    </aside>
  );
}
