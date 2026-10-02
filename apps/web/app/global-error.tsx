"use client";

import type { CSSProperties } from "react";

/**
 * Root-layout failure boundary (#96): renders when the ROOT layout itself
 * throws, so no shell (AppShell, providers, globals.css tokens) can be
 * assumed. Minimal standalone markup with inline styles, its own
 * <html>/<body>, a plain Retry (reset + full reload) and a Go home link.
 * Dev detail shows the error inline; there is intentionally no diagnostics
 * pipeline here — keep this path as small as possible.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isDev = process.env.NODE_ENV !== "production";
  const buttonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  };
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#0b0f14",
          color: "#e6edf3",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <main role="alert" style={{ maxWidth: "34rem", padding: "2rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "#94a3b8" }}>
            The application shell failed to load. Reload to recover, or head back home.
          </p>
          {isDev ? (
            <pre
              style={{
                marginTop: "1rem",
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #263041",
                background: "#171e26",
                color: "#f85149",
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >{`${error.name}: ${error.message}`}</pre>
          ) : null}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.25rem" }}>
            <button
              type="button"
              onClick={() => {
                reset();
                window.location.reload();
              }}
              style={{
                ...buttonStyle,
                background: "#2563eb",
                border: "1px solid #2563eb",
                color: "#ffffff",
              }}
            >
              Retry
            </button>
            {/* Plain anchor on purpose: shell-free recovery wants a full
                document load, not a client-side <Link> navigation. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                ...buttonStyle,
                background: "transparent",
                border: "1px solid #263041",
                color: "#e6edf3",
                textDecoration: "none",
              }}
            >
              Go home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
