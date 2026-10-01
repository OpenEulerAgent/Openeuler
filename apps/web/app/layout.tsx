import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AppShell } from "@/components/shell/AppShell";
import { ToastProvider } from "@/components/ui/toast";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { SIDEBAR_INIT_SCRIPT } from "@/lib/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Openeuler", template: "%s · Openeuler" },
  description: "Openeuler web app",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-sidebar="expanded" suppressHydrationWarning>
      <head>
        {/* Applies the persisted theme + sidebar preference before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-body text-fg antialiased">
        <ThemeProvider>
          <ToastProvider>
            <AppShell>{children}</AppShell>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
