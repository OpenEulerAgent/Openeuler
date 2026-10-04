// @vitest-environment jsdom
//
// Approval banner (#118): renders the gate's prompt + waiting-elapsed line,
// Approve POSTs {approve:true, note}, Reject asks for an inline confirm
// before POSTing {approve:false}, 409 tolerance (gate resolved elsewhere /
// timed out → refresh, no error), and renders nothing when no gate is open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApprovalBanner } from "./ApprovalBanner";
import type { RunAwaitingView } from "@/lib/approval";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const render = async (node: () => ReactNode): Promise<void> => {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(node());
  });
  await settle();
};

/** Flushes pending microtasks inside act (probe promises land). */
const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const fetchMock = vi.fn();

const ok = (): Response => new Response("{}", { status: 200 });
const conflict = (): Response =>
  new Response(JSON.stringify({ error: { code: "RUN_NOT_AWAITING", message: "not awaiting" } }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });

const awaiting = (since = new Date(Date.now() - 60_000).toISOString()): RunAwaitingView => ({
  nodeId: "gate",
  nodeName: "Human check",
  prompt: "Ship these changes?",
  since,
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const props = (overrides: Partial<Parameters<typeof ApprovalBanner>[0]> = {}) => ({
  runId: "run-1",
  awaiting: awaiting(),
  nowMs: Date.now(),
  live: true,
  onChanged: () => {},
  ...overrides,
});

describe("ApprovalBanner (#118)", () => {
  it("renders nothing when no gate is open", async () => {
    await render(() => createElement(ApprovalBanner, props({ awaiting: null })));
    expect(container?.textContent).toBe("");
  });

  it("shows the prompt, node name and waiting line; hides actions when not live", async () => {
    const onChanged = vi.fn();
    await render(() => createElement(ApprovalBanner, props({ live: false, onChanged })));
    expect(container?.querySelector("[data-approval-banner]")).not.toBeNull();
    expect(container?.querySelector("[data-approval-prompt]")?.textContent).toContain(
      "Ship these changes?",
    );
    expect(container?.querySelector("[data-approval-since]")).not.toBeNull();
    expect(container?.querySelector("[data-approval-approve]")).toBeNull();
    expect(container?.textContent).toContain("resume it to act");
  });

  it("Approve POSTs the decision with the note and refreshes", async () => {
    fetchMock.mockResolvedValue(ok());
    const onChanged = vi.fn();
    await render(() => createElement(ApprovalBanner, props({ onChanged })));

    const note = container?.querySelector<HTMLInputElement>("[data-approval-note]");
    act(() => {
      note?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Set value through the native setter so React registers it.
    if (note !== null && note !== undefined) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(note, "looks good");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();

    const approve = container?.querySelector("[data-approval-approve]") as HTMLButtonElement;
    await act(async () => {
      approve?.click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/runs/run-1/approvals/gate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ approve: true, note: "looks good" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container?.textContent).not.toContain("Failed");
  });

  it("Reject asks for a confirm before POSTing approve:false", async () => {
    fetchMock.mockResolvedValue(ok());
    const onChanged = vi.fn();
    await render(() => createElement(ApprovalBanner, props({ onChanged })));

    const reject = container?.querySelector("[data-approval-reject]") as HTMLButtonElement;
    await act(async () => {
      reject?.click();
    });
    await settle();
    // No POST yet — the confirm step is showing.
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = container?.querySelector("[data-approval-reject-confirm]") as HTMLButtonElement;
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm?.click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ approve: false });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("a 409 (resolved elsewhere / timed out) refreshes without an error", async () => {
    fetchMock.mockResolvedValue(conflict());
    const onChanged = vi.fn();
    await render(() => createElement(ApprovalBanner, props({ onChanged })));
    const approve = container?.querySelector("[data-approval-approve]") as HTMLButtonElement;
    await act(async () => {
      approve?.click();
    });
    await settle();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container?.textContent).not.toContain("Failed");
  });

  it("other failures surface an error and keep the banner", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "BOOM", message: "daemon sad" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChanged = vi.fn();
    await render(() => createElement(ApprovalBanner, props({ onChanged })));
    const approve = container?.querySelector("[data-approval-approve]") as HTMLButtonElement;
    await act(async () => {
      approve?.click();
    });
    await settle();
    expect(onChanged).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("daemon sad");
  });
});
