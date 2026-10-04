// @vitest-environment jsdom
//
// Artifacts tab (#122): manifest table (paths + sizes + totals), truncated
// banner, download + copy-path affordances, empty/pending/error states. The
// daemon API layer is mocked at the lib boundary; RunDetailView's mounting
// behavior is covered in RunDetailView.test.tsx.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArtifactsTab } from "./ArtifactsTab";
import type { RunArtifactsBody } from "@/lib/artifacts-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const manifest: RunArtifactsBody = {
  runId: "run-1",
  runStatus: "success",
  capturedAt: "2026-01-01T00:00:00.000Z",
  patterns: ["dist/**", "!**/*.map"],
  files: [
    { path: "dist/app.js", size: 2048 },
    { path: "dist/assets/style.css", size: 4096 },
  ],
  totalBytes: 6144,
  truncated: false,
};

const api = vi.hoisted(() => ({
  fetchRunArtifacts: vi.fn(),
  downloadRunArtifact: vi.fn(),
}));

vi.mock("@/lib/artifacts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts-api")>()),
  fetchRunArtifacts: api.fetchRunArtifacts,
  downloadRunArtifact: api.downloadRunArtifact,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = async (node: () => ReactNode): Promise<void> => {
  // Fresh mount per call: the tab's load effect keys on (runId, terminal),
  // which do not change between tests — a reused root would keep stale state.
  if (container !== null) container.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node());
  });
  await settle();
};

/** Flushes microtasks (and pending timers) inside act. */
const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

afterEach(() => {
  api.fetchRunArtifacts.mockReset();
  api.downloadRunArtifact.mockReset();
});

describe("ArtifactsTab", () => {
  it("renders the manifest table with sizes and totals", async () => {
    api.fetchRunArtifacts.mockResolvedValue(manifest);
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));

    const table = document.querySelector('[data-testid="artifacts-table"]');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("dist/app.js");
    expect(table?.textContent).toContain("2.0 KiB");
    expect(table?.textContent).toContain("4.0 KiB");
    expect(table?.textContent).toContain("6.0 KiB");
    expect(table?.textContent).toContain("2 files");
    expect(document.querySelector('[data-testid="artifacts-truncated-banner"]')).toBeNull();
  });

  it("shows the truncated banner when the capture was capped", async () => {
    api.fetchRunArtifacts.mockResolvedValue({
      ...manifest,
      truncated: true,
      warning: "partial capture: stopped after 200 files",
    });
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));

    const banner = document.querySelector('[data-testid="artifacts-truncated-banner"]');
    expect(banner?.textContent).toContain("partial capture");
  });

  it("downloads via the authenticated client when Download is clicked", async () => {
    api.fetchRunArtifacts.mockResolvedValue(manifest);
    api.downloadRunArtifact.mockResolvedValue(undefined);
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));

    const button = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Download dist/app.js",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(api.downloadRunArtifact).toHaveBeenCalledWith("run-1", "dist/app.js");
  });

  it("copies the path and flashes Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    api.fetchRunArtifacts.mockResolvedValue(manifest);
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));

    const button = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Copy path dist/assets/style.css",
    );
    expect(button?.textContent).toContain("Copy path");
    await act(async () => {
      button?.click();
    });
    expect(writeText).toHaveBeenCalledWith("dist/assets/style.css");
    expect(button?.textContent).toContain("Copied");
  });

  it("surfaces download failures inline", async () => {
    api.fetchRunArtifacts.mockResolvedValue(manifest);
    api.downloadRunArtifact.mockRejectedValue(new Error("daemon unreachable"));
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));

    const button = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Download dist/app.js",
    );
    await act(async () => {
      button?.click();
    });
    await settle();
    expect(document.querySelector('[data-testid="artifacts-download-error"]')?.textContent).toBe(
      "daemon unreachable",
    );
  });

  it("explains that artifacts appear once the run finishes (live run)", async () => {
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: false }));
    expect(document.querySelector('[data-testid="artifacts-pending"]')?.textContent).toContain(
      "captured when the run finishes",
    );
    expect(api.fetchRunArtifacts).not.toHaveBeenCalled();
  });

  it("retries once when the terminal event beats artifact capture", async () => {
    api.fetchRunArtifacts
      .mockRejectedValueOnce(Object.assign(new Error("not yet"), { status: 404 }))
      .mockResolvedValueOnce(manifest);
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.fetchRunArtifacts).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="artifacts-table"]')).not.toBeNull();
  });

  it("polls ARTIFACTS_PENDING until the manifest lands", async () => {
    api.fetchRunArtifacts
      .mockRejectedValueOnce(Object.assign(new Error("capture running"), { status: 409 }))
      .mockResolvedValueOnce(manifest);
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.fetchRunArtifacts).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="artifacts-table"]')).not.toBeNull();
  });

  it("shows the empty state for runs without a capture", async () => {
    api.fetchRunArtifacts.mockRejectedValue(Object.assign(new Error("none"), { status: 404 }));
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.fetchRunArtifacts).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="artifacts-empty"]')).not.toBeNull();
  });

  it("shows an error with retry for real failures", async () => {
    api.fetchRunArtifacts.mockRejectedValue(Object.assign(new Error("boom"), { status: 0 }));
    await render(() => createElement(ArtifactsTab, { runId: "run-1", terminal: true }));
    const error = document.querySelector('[data-testid="artifacts-error"]');
    expect(error?.textContent).toContain("boom");

    api.fetchRunArtifacts.mockResolvedValue(manifest);
    const retry = [...(error?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes("Retry"),
    );
    await act(async () => {
      retry?.click();
    });
    await settle();
    expect(document.querySelector('[data-testid="artifacts-table"]')).not.toBeNull();
  });
});
