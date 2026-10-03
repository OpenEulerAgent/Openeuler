// @vitest-environment jsdom
//
// Preview panel (#109): port chips (declared selectable, detected+hint
// disabled), lazy iframe with the prescribed sandbox + token URL, HEAD-poll
// pill transitions (connecting → live → lost → retry), reload re-key,
// clipboard+window.open for "Open in new tab", and poll teardown on
// unmount. The tab itself is only mounted by RunDetailView while active —
// the lazy-mount-before-visible behavior is covered in
// RunDetailView.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PreviewTab } from "./PreviewTab";
import { __resetMemoryToken, storeToken } from "@/lib/token";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const HINT =
  "detected in run output; declare ports on the run to preview it (v0.2 publishes declared ports only)";

const ports = [
  { container: 3000, host: 49153, declared: true },
  { container: 8080, host: 49154, declared: true },
  { container: 5173, declared: false, hint: HINT },
];

// --- harness ----------------------------------------------------------------

let root: Root | null = null;
let container: HTMLElement | null = null;

/**
 * Mounts the panel and lets the initial HEAD probe land inside act —
 * assertions then run against a settled pill.
 */
const render = async (node: () => ReactNode): Promise<void> => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node());
  });
  await settle(1);
};

const fetchMock = vi.fn();

const ok = (): Response => new Response(null, { status: 200 });

/** Flushes pending microtasks inside act (probe promises land). */
const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      // Under fake timers a real setTimeout never fires — advance 0ms,
      // which flushes due timers plus the microtask queue.
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }
};

const frame = (): HTMLIFrameElement =>
  document.querySelector("[data-preview-frame]") as HTMLIFrameElement;

const pill = (): HTMLElement => document.querySelector("[data-preview-state]") as HTMLElement;

const clickButton = (label: string): void => {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  ) as HTMLElement;
  act(() => {
    button.click();
  });
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok());
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  __resetMemoryToken();
  vi.useRealTimers();
});

describe("PreviewTab chips (#109)", () => {
  it("renders one chip per port; declared selectable, detected disabled with the hint tooltip", async () => {
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));

    const chips = [...document.querySelectorAll("[data-preview-chip]")];
    expect(chips.map((chip) => chip.getAttribute("data-preview-chip"))).toEqual([
      "3000",
      "8080",
      "5173",
    ]);
    expect((chips[0] as HTMLButtonElement).disabled).toBe(false);
    expect((chips[2] as HTMLButtonElement).disabled).toBe(true);
    expect(chips[2]?.getAttribute("title")).toBe(HINT);
    // Detected chips say so.
    expect(chips[2]?.textContent).toContain("detected");
  });

  it("defaults to the first port with a host mapping and switching ports swaps the frame + probe", async () => {
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));

    expect(document.querySelector('[data-preview-chip="3000"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(frame().getAttribute("src")).toBe("/previews/run-1/3000/");

    act(() => {
      (document.querySelector('[data-preview-chip="8080"]') as HTMLElement).click();
    });
    await settle();

    expect(document.querySelector('[data-preview-chip="8080"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(frame().getAttribute("src")).toBe("/previews/run-1/8080/");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/previews/run-1/8080/")).toBe(
      true,
    );
  });
});

describe("PreviewTab iframe (#109)", () => {
  it("frames the proxy URL with the stored token, the prescribed sandbox and an a11y title", async () => {
    storeToken("tok-1");
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));

    const iframe = frame();
    expect(iframe.getAttribute("src")).toBe("/previews/run-1/3000/?token=tok-1");
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-forms allow-scripts allow-same-origin allow-modals",
    );
    expect(iframe.getAttribute("title")).toContain("3000");
  });

  it("re-keys the iframe on Reload (fresh element, same src)", async () => {
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));
    const before = frame();
    const src = before.getAttribute("src");

    clickButton("Reload");
    const after = frame();

    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(after.getAttribute("src")).toBe(src);
  });
});

describe("state pill (#109)", () => {
  it("connects, goes live on a 2xx HEAD, lost on failure, and recovers via Retry", async () => {
    vi.useFakeTimers();
    // Hold the first probe so "connecting" is observed deterministically.
    let resolveFirst!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockImplementation(async () => ok());
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));

    // Initial probe in flight: connecting.
    expect(pill().getAttribute("data-preview-state")).toBe("connecting");
    await act(async () => {
      resolveFirst(ok());
    });
    expect(pill().getAttribute("data-preview-state")).toBe("live");
    expect(pill().textContent).toBe("Live");

    // Next poll fails (502 from the proxy) → lost + retry affordance.
    fetchMock.mockImplementation(async () => new Response("upstream down", { status: 502 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(pill().getAttribute("data-preview-state")).toBe("lost");
    expect(pill().className).toContain("text-danger");
    expect(
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Retry"),
      ),
    ).toBe(true);

    // Retry re-probes immediately and recovers.
    fetchMock.mockImplementation(async () => ok());
    clickButton("Retry");
    await settle();
    expect(pill().getAttribute("data-preview-state")).toBe("live");
  });

  it("counts a network rejection as lost", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));
    await settle();
    expect(pill().getAttribute("data-preview-state")).toBe("lost");
  });

  it("aborts the probe after the 3s timeout", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its signal aborts — like a hung proxy.
    fetchMock.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await settle();
    expect(pill().getAttribute("data-preview-state")).toBe("lost");
  });
});

describe("Open in new tab (#109)", () => {
  const clipboardMock = vi.hoisted(() => ({ writes: [] as string[], fail: false }));

  const installClipboard = (): void => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string): Promise<void> => {
          if (clipboardMock.fail) throw new Error("clipboard denied");
          clipboardMock.writes.push(text);
        },
      },
    });
  };

  beforeEach(() => {
    clipboardMock.writes = [];
    clipboardMock.fail = false;
    installClipboard();
  });

  it("opens the absolute (location.origin) URL with the token and copies it to the clipboard", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    storeToken("tok-1");
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));

    clickButton("Open in new tab");

    const expected = `${window.location.origin}/previews/run-1/3000/?token=tok-1`;
    expect(openSpy).toHaveBeenCalledWith(expected, "_blank", "noopener,noreferrer");
    expect(clipboardMock.writes).toEqual([expected]);
    openSpy.mockRestore();
  });

  it("still opens when the clipboard rejects", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    clipboardMock.fail = true;
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));

    clickButton("Open in new tab");
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(clipboardMock.writes).toEqual([]);
    openSpy.mockRestore();
  });
});

describe("empty + terminal states (#109)", () => {
  it("explains port declaration + detection when nothing is previewable", async () => {
    await render(() =>
      createElement(PreviewTab, {
        runId: "run-1",
        ports: [{ container: 5173, declared: false, hint: HINT }],
        terminal: false,
      }),
    );

    expect(document.querySelector("[data-preview-frame]")).toBeNull();
    expect(document.querySelector("[data-preview-empty]")).not.toBeNull();
    expect(document.querySelector("[data-preview-empty]")?.textContent).toContain(
      "Declare container ports",
    );
    expect(document.querySelector("[data-preview-empty]")?.textContent).toContain("detected");
    // Hint tooltip still explains the disabled chip.
    expect(document.querySelector("[data-preview-chip='5173']")?.getAttribute("title")).toBe(HINT);
  });

  it("shows the sandbox-closed note on terminal runs without host mappings, not on live ones", async () => {
    const terminalPorts = [{ container: 3000, declared: true }];
    await render(() =>
      createElement(PreviewTab, { runId: "run-1", ports: terminalPorts, terminal: true }),
    );
    expect(document.querySelector("[data-preview-terminal-note]")?.textContent).toContain(
      "Run finished — sandbox closed",
    );

    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));
    expect(document.querySelector("[data-preview-terminal-note]")).toBeNull();
  });
});

describe("poll lifecycle (#109)", () => {
  it("re-probes every 5s while mounted and stops entirely on unmount", async () => {
    vi.useFakeTimers();
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    act(() => {
      root?.unmount();
    });
    root = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("probes HEAD through the proxy URL with the bearer header (query tokens are GET-only)", async () => {
    storeToken("tok-1");
    await render(() => createElement(PreviewTab, { runId: "run-1", ports, terminal: false }));
    await settle();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/previews/run-1/3000/?token=tok-1");
    expect(init.method).toBe("HEAD");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });
});
