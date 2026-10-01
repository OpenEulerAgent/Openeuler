/**
 * Inline SVG icon set for the app shell + command palette (issue #50).
 * Stroke-based, `currentColor`, 16×16 viewBox — sized via className.
 */
import type { ReactNode } from "react";

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className ?? "size-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function DashboardIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </Icon>
  );
}

export function FolderIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M2 4.75A1.75 1.75 0 0 1 3.75 3h2.9a1.5 1.5 0 0 1 1.06.44l.6.6a1.5 1.5 0 0 0 1.06.44h2.88A1.75 1.75 0 0 1 14 6.23V11.5a1.75 1.75 0 0 1-1.75 1.75h-8.5A1.75 1.75 0 0 1 2 11.5z" />
    </Icon>
  );
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M5.5 3.4v9.2l7.2-4.6z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function SlidersIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M2 4.5h12M2 8h12M2 11.5h12" />
      <circle cx="6" cy="4.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="6.75" cy="6.75" r="4.25" />
      <path d="M10 10l3.5 3.5" />
    </Icon>
  );
}

export function StopIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PanelLeftIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
      <path d="M6 2.75v10.5" />
    </Icon>
  );
}

export function SunIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.25 3.25l1 1M11.75 11.75l1 1M12.75 3.25l-1 1M4.25 11.75l-1 1" />
    </Icon>
  );
}

export function MoonIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M13.5 9.75A6 6 0 0 1 6.25 2.5a6 6 0 1 0 7.25 7.25z" />
    </Icon>
  );
}

export function BoxIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M8 1.75l5.75 3.13v6.24L8 14.25l-5.75-3.13V4.88z" />
      <path d="M2.5 5.1L8 8l5.5-2.9M8 8v6" />
    </Icon>
  );
}

export function InboxIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M2.25 9.25L4 3.25h8l1.75 6v3a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M2.25 9.25h3l.75 1.5h4l.75-1.5h3" />
    </Icon>
  );
}
