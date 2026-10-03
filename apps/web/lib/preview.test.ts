import { describe, expect, it } from "vitest";
import {
  buildPreviewUrl,
  DECLARE_PORT_HINT,
  defaultPreviewPort,
  isPreviewPortSelectable,
  PREVIEW_IFRAME_SANDBOX,
  previewPillMeta,
  previewStateAfterProbe,
  showTerminalPreviewNote,
  type PreviewPortView,
} from "./preview";

/** Declared port with a live host mapping. */
const hosted = (container: number, host: number): PreviewPortView => ({
  container,
  host,
  declared: true,
});

/** Declared port whose mapping is gone (local or terminal run). */
const declaredOnly = (container: number): PreviewPortView => ({
  container,
  declared: true,
});

/** Detected-but-undeclared port carrying the daemon's hint (#107). */
const detected = (container: number): PreviewPortView => ({
  container,
  declared: false,
  hint: "detected in run output; declare ports on the run to preview it (v0.2 publishes declared ports only)",
});

describe("buildPreviewUrl (#109)", () => {
  it("places the encoded runId and port in the path with a trailing slash", () => {
    expect(buildPreviewUrl("run-1", 3000)).toBe("/previews/run-1/3000/");
    expect(buildPreviewUrl("run/1", 8080)).toBe("/previews/run%2F1/8080/");
  });

  it("appends a stored token as encoded ?token= and drops blank tokens", () => {
    expect(buildPreviewUrl("run-1", 3000, "tok-1")).toBe("/previews/run-1/3000/?token=tok-1");
    expect(buildPreviewUrl("run-1", 3000, "two words")).toBe(
      "/previews/run-1/3000/?token=two%20words",
    );
    expect(buildPreviewUrl("run-1", 3000, null)).toBe("/previews/run-1/3000/");
    expect(buildPreviewUrl("run-1", 3000, undefined)).toBe("/previews/run-1/3000/");
    expect(buildPreviewUrl("run-1", 3000, "   ")).toBe("/previews/run-1/3000/");
  });
});

describe("port chip decisions", () => {
  it("only declared ports are selectable (v0.2 publishes declared ports)", () => {
    expect(isPreviewPortSelectable(hosted(3000, 1))).toBe(true);
    expect(isPreviewPortSelectable(declaredOnly(3000))).toBe(true);
    expect(isPreviewPortSelectable(detected(5173))).toBe(false);
  });

  it("default selection is the first port with a host mapping", () => {
    expect(defaultPreviewPort([hosted(8080, 1), hosted(3000, 2)])).toBe(8080);
    // First LISTED port has no mapping: the first mapped one wins.
    expect(defaultPreviewPort([declaredOnly(3000), hosted(5173, 9)])).toBe(5173);
  });

  it("falls back to the first declared port, then null (only undeclared / none)", () => {
    expect(defaultPreviewPort([declaredOnly(3000), detected(5173)])).toBe(3000);
    expect(defaultPreviewPort([detected(5173), detected(6000)])).toBeNull();
    expect(defaultPreviewPort([])).toBeNull();
  });

  it("keeps the sandbox token set exactly as prescribed (documented why)", () => {
    expect(PREVIEW_IFRAME_SANDBOX).toBe("allow-forms allow-scripts allow-same-origin allow-modals");
  });

  it("exposes a fallback tooltip for hint-less undeclared ports", () => {
    expect(DECLARE_PORT_HINT).toBe("declare ports on the run to preview");
  });
});

describe("preview state pill", () => {
  it("maps probe results to states", () => {
    expect(previewStateAfterProbe(true)).toBe("live");
    expect(previewStateAfterProbe(false)).toBe("lost");
  });

  it("labels and colors the three states (lost is the red one)", () => {
    expect(previewPillMeta("connecting")).toMatchObject({
      label: "Connecting…",
      variant: "neutral",
    });
    expect(previewPillMeta("live")).toMatchObject({ label: "Live", variant: "success" });
    expect(previewPillMeta("lost")).toMatchObject({ label: "Lost", variant: "danger" });
    expect(previewPillMeta("lost").title.length).toBeGreaterThan(0);
  });
});

describe("terminal teardown notice", () => {
  it("shows only for terminal runs whose ports have no host mappings left", () => {
    expect(showTerminalPreviewNote({ terminal: true, ports: [declaredOnly(3000)] })).toBe(true);
    expect(showTerminalPreviewNote({ terminal: true, ports: [detected(5173)] })).toBe(true);
    expect(showTerminalPreviewNote({ terminal: true, ports: [] })).toBe(false);
    expect(
      showTerminalPreviewNote({ terminal: true, ports: [declaredOnly(3000), hosted(8080, 1)] }),
    ).toBe(false);
    expect(showTerminalPreviewNote({ terminal: false, ports: [declaredOnly(3000)] })).toBe(false);
  });
});
