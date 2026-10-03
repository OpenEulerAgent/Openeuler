// @vitest-environment jsdom
//
// Project settings drawer (#93 secrets, #101 sandbox policy, #111 worktrees).
// Secrets pane: the list renders names + created dates only — a value column
// must never exist; add calls PUT, delete needs a confirm click. Sandbox
// pane: loads the saved policy + image catalog, PATCHes the whole policy,
// shows inline validation errors and the "limited does not filter egress"
// honesty note. Worktrees pane: rows with status badges + usage bars, totals
// card, copy path, and prune flows (selected entry / all orphans) behind
// confirm clicks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ProjectSettingsDrawer } from "./ProjectSettingsDrawer";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const BASE = "http://localhost:8787";
const PROJECT = "p1";

/**
 * Route-table fetch mock: mounting the drawer now fans out three GETs
 * (project, image catalog, secrets) whose ordering belongs to React, not
 * the tests — so replies are keyed by `METHOD path` instead of FIFO.
 * A route value is a payload (always 200), `{status, body}`, a function
 * returning either, or an array consumed FIFO.
 */
type RouteReply =
  | unknown
  | { status: number; body: unknown }
  | (() => unknown | { status: number; body: unknown })
  | RouteReply[];

type RouteSpec = Record<`${string} ${string}`, RouteReply>;

const fetchMock = vi.fn();
const routes = new Map<string, RouteReply>();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installRoutes(spec: RouteSpec): void {
  routes.clear();
  for (const [key, reply] of Object.entries(spec)) routes.set(key, reply);
}

beforeEach(() => {
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(BASE, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    let reply = routes.get(key);
    if (Array.isArray(reply)) reply = reply.shift();
    if (reply === undefined) {
      return Promise.resolve(
        jsonResponse({ error: { code: "NOT_MOCKED", message: `no route for ${key}` } }, 500),
      );
    }
    const resolved = typeof reply === "function" ? reply() : reply;
    const payload =
      resolved !== null && typeof resolved === "object" && "status" in (resolved as object)
        ? (resolved as { status: number; body: unknown })
        : { status: 200, body: resolved };
    // Null-body statuses (204) must not carry a body — undici throws.
    if (payload.status === 204 || payload.body === null) {
      return Promise.resolve(new Response(null, { status: payload.status }));
    }
    return Promise.resolve(jsonResponse(payload.body, payload.status));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(
        ToastProvider,
        null,
        createElement(ProjectSettingsDrawer, {
          projectId: PROJECT,
          onClose: () => {},
        }) as ReactNode,
      ),
    ),
  );
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const text = (): string => document.body.textContent ?? "";

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;

const fireValue = (
  el: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: string,
): void => {
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event(eventName, { bubbles: true }));
  });
};

const setInput = (id: string, value: string): void => {
  const el = document.getElementById(id) as HTMLInputElement | null;
  expect(el).not.toBeNull();
  fireValue(el as HTMLInputElement, value, "input");
};
const setSelect = (id: string, value: string): void => {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  expect(el).not.toBeNull();
  fireValue(el as HTMLSelectElement, value, "change");
};

const submitForm = (index: number): void => {
  const form = document.querySelectorAll("form")[index];
  expect(form).toBeDefined();
  act(() => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};

type FetchCall = [string, RequestInit | undefined];

const calls = (method: string, path: string): FetchCall[] =>
  fetchMock.mock.calls
    .map((call) => call as FetchCall)
    .filter(
      ([url, init]) => String(url).replace(BASE, "") === path && (init?.method ?? "GET") === method,
    );

/** Default mount routes: empty project policy, empty catalog, secrets list, docker up (#106), worktrees (#111). */
function mountRoutes(extra: RouteSpec = {}): RouteSpec {
  return {
    [`GET /api/projects/${PROJECT}`]: { project: {} },
    "GET /api/sandbox/images": { images: [] },
    [`GET /api/projects/${PROJECT}/secrets`]: { secrets: [] },
    [`GET /api/projects/${PROJECT}/worktrees`]: { worktrees: [], totalBytes: 0 },
    [`GET /api/sandbox/status?projectId=${PROJECT}`]: {
      available: true,
      version: "27.3.1",
      mode: "docker",
      projectMode: "local",
      effective: "local",
    },
    ...extra,
  };
}

describe("ProjectSettingsDrawer secrets pane (#93)", () => {
  it("lists names + created dates only — never values", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/secrets`]: {
          secrets: [
            { name: "NPM_TOKEN", createdAt: "2026-01-01T00:00:00.000Z" },
            { name: "API_KEY", createdAt: "2026-02-02T00:00:00.000Z" },
          ],
        },
      }),
    );
    render();
    await settle();

    expect(text()).toContain("NPM_TOKEN");
    expect(text()).toContain("API_KEY");
    expect(text()).not.toContain("No secrets yet");
    expect(calls("GET", `/api/projects/${PROJECT}/secrets`)).toHaveLength(1);
  });

  it("shows the empty state when the project has no secrets", async () => {
    installRoutes(mountRoutes());
    render();
    await settle();
    expect(text()).toContain("No secrets yet");
  });

  it("adds a secret: PUT with name+value, toast, refreshed list", async () => {
    installRoutes(
      mountRoutes({
        [`PUT /api/projects/${PROJECT}/secrets`]: {
          secret: { name: "NPM_TOKEN", createdAt: "x" },
        },
        [`GET /api/projects/${PROJECT}/secrets`]: [
          { secrets: [] },
          { secrets: [{ name: "NPM_TOKEN", createdAt: "x" }] },
        ],
      }),
    );
    render();
    await settle();

    setInput("secret-name", "NPM_TOKEN");
    setInput("secret-value", "npat_super_secret_1");
    submitForm(0);
    await settle();

    const put = calls("PUT", `/api/projects/${PROJECT}/secrets`);
    expect(put[0]?.[1]?.body).toBe(
      JSON.stringify({ name: "NPM_TOKEN", value: "npat_super_secret_1" }),
    );
    expect(text()).toContain("Saved NPM_TOKEN");
    expect(text()).not.toContain("npat_super_secret_1");
    expect((document.getElementById("secret-value") as HTMLInputElement)?.value).toBe("");
  });

  it("blocks an invalid name client-side with the env-var rule message", async () => {
    installRoutes(mountRoutes());
    render();
    await settle();

    setInput("secret-name", "bad-name");
    setInput("secret-value", "some-value-1");
    submitForm(0);
    await settle();

    expect(text()).toMatch(/secret name must match/);
    expect(calls("PUT", `/api/projects/${PROJECT}/secrets`)).toHaveLength(0);
  });

  it("delete requires a confirm click, then DELETEs and toasts", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/secrets`]: {
          secrets: [{ name: "NPM_TOKEN", createdAt: "x" }],
        },
        [`DELETE /api/projects/${PROJECT}/secrets/NPM_TOKEN`]: { status: 204, body: null },
      }),
    );
    render();
    await settle();

    act(() => button("Delete NPM_TOKEN")?.click());
    await settle();
    expect(calls("DELETE", `/api/projects/${PROJECT}/secrets/NPM_TOKEN`)).toHaveLength(0);

    act(() => button("Confirm delete NPM_TOKEN")?.click());
    await settle();
    expect(calls("DELETE", `/api/projects/${PROJECT}/secrets/NPM_TOKEN`)).toHaveLength(1);
    expect(text()).toContain("Deleted NPM_TOKEN");
  });

  it("surfaces a daemon 422 on save as a danger toast", async () => {
    installRoutes(
      mountRoutes({
        [`PUT /api/projects/${PROJECT}/secrets`]: {
          status: 422,
          body: {
            error: {
              code: "VALIDATION_ERROR",
              message: "secret name must match ^[A-Z_][A-Z0-9_]*$",
            },
          },
        },
      }),
    );
    render();
    await settle();

    setInput("secret-name", "OK_NAME");
    setInput("secret-value", "v-123456");
    submitForm(0);
    await settle();

    expect(text()).toContain("Could not save secret");
  });

  it("explains when the daemon has no secret key (SECRETS_UNAVAILABLE)", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/secrets`]: {
          status: 503,
          body: { error: { code: "SECRETS_UNAVAILABLE", message: "no key" } },
        },
      }),
    );
    render();
    await settle();

    expect(text()).toContain("no secret key loaded");
    const save = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save secret"),
    );
    expect(save?.disabled).toBe(true);
  });
});

describe("ProjectSettingsDrawer sandbox policy pane (#101)", () => {
  const savedPolicy = {
    executionMode: "sandbox",
    image: "openeuler/worker:latest",
    cpus: 4,
    memoryMb: 4096,
    network: "limited",
    cachePaths: ["/root/.cache"],
    keepForDebug: true,
  };

  const catalog = {
    images: [
      { repository: "busybox", tag: "1.36", id: "i1", sizeBytes: 1, createdAt: 1, ours: false },
      {
        repository: "openeuler/worker",
        tag: "latest",
        id: "i2",
        sizeBytes: 2,
        createdAt: 2,
        ours: true,
      },
    ],
  };

  it("loads the saved policy into the form (ours-first catalog select)", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}`]: { project: { sandboxPolicy: savedPolicy } },
        "GET /api/sandbox/images": catalog,
      }),
    );
    render();
    await settle();

    expect((document.getElementById("policy-execution-mode") as HTMLSelectElement)?.value).toBe(
      "sandbox",
    );
    const imageSelect = document.getElementById("policy-image") as HTMLSelectElement;
    expect(imageSelect?.value).toBe("openeuler/worker:latest");
    // ours first in the option order.
    expect(imageSelect?.options[1]?.value).toBe("openeuler/worker:latest");
    expect(imageSelect?.options[1]?.textContent).toContain("★");
    expect((document.getElementById("policy-cpus-num") as HTMLInputElement)?.value).toBe("4");
    expect((document.getElementById("policy-memory-num") as HTMLInputElement)?.value).toBe("4096");
    expect((document.getElementById("policy-network") as HTMLSelectElement)?.value).toBe("limited");
    expect((document.getElementById("policy-keep-for-debug") as HTMLInputElement)?.checked).toBe(
      true,
    );
    // Honesty note visible while limited is selected.
    expect(document.querySelector("[data-limited-note]")).not.toBeNull();
  });

  it("PATCHes the whole policy on save, preserving fields the form does not edit", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}`]: { project: { sandboxPolicy: savedPolicy } },
        "GET /api/sandbox/images": catalog,
        [`PATCH /api/projects/${PROJECT}/policy`]: { project: { sandboxPolicy: savedPolicy } },
      }),
    );
    render();
    await settle();

    // Edit cpus to 8 via the slider, mode to local, keep cachePaths carried.
    setInput("policy-cpus", "8");
    setSelect("policy-execution-mode", "local");
    submitForm(1);
    await settle();

    const patch = calls("PATCH", `/api/projects/${PROJECT}/policy`);
    expect(patch).toHaveLength(1);
    expect(JSON.parse(String(patch[0]?.[1]?.body))).toEqual({
      ...savedPolicy,
      executionMode: "local",
      cpus: 8,
    });
    expect(text()).toContain("Sandbox policy saved");
  });

  it("blocks out-of-clamp values client-side with the core message, no PATCH", async () => {
    installRoutes(mountRoutes());
    render();
    await settle();

    setInput("policy-cpus-num", "99");
    submitForm(1);
    await settle();

    expect(text()).toContain("cpus must be <= 8");
    expect(calls("PATCH", `/api/projects/${PROJECT}/policy`)).toHaveLength(0);
  });

  it("surfaces a daemon 422 inline with the field path", async () => {
    installRoutes(
      mountRoutes({
        [`PATCH /api/projects/${PROJECT}/policy`]: {
          status: 422,
          body: {
            error: {
              code: "VALIDATION_ERROR",
              message: "memoryMb must be <= 8192",
              details: [{ path: "memoryMb", message: "memoryMb must be <= 8192" }],
            },
          },
        },
      }),
    );
    render();
    await settle();

    submitForm(1);
    await settle();

    expect(document.querySelector("[data-policy-error]")?.textContent).toContain(
      "memoryMb must be <= 8192 (memoryMb: memoryMb must be <= 8192)",
    );
    expect(text()).toContain("Could not save policy");
  });

  it("falls back to a manual image input when the catalog is empty or unreachable", async () => {
    installRoutes(
      mountRoutes({
        "GET /api/sandbox/images": {
          status: 503,
          body: { error: { code: "SANDBOX_UNAVAILABLE" } },
        },
      }),
    );
    render();
    await settle();

    const input = document.getElementById("policy-image") as HTMLInputElement | null;
    expect(input?.tagName).toBe("INPUT");
    expect(text()).toContain("No catalog images available");
  });

  it("keeps an unknown saved image editable as free text instead of dropping it", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}`]: {
          project: { sandboxPolicy: { executionMode: "sandbox", image: "private/reg:9" } },
        },
        "GET /api/sandbox/images": catalog,
      }),
    );
    render();
    await settle();

    const input = document.getElementById("policy-image") as HTMLInputElement | null;
    expect(input?.tagName).toBe("INPUT");
    expect(input?.value).toBe("private/reg:9");
  });

  it("shows a retry affordance when the policy fails to load", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}`]: {
          status: 500,
          body: { error: { code: "INTERNAL_ERROR", message: "boom" } },
        },
      }),
    );
    render();
    await settle();

    expect(text()).toContain("Could not load the sandbox policy");
    expect(button("Retry")).toBeDefined();
  });

  it("renders the live effective-mode hint under the execution mode select (#106)", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}`]: {
          project: { sandboxPolicy: { executionMode: "auto" } },
        },
        [`GET /api/sandbox/status?projectId=${PROJECT}`]: {
          available: false,
          mode: "unavailable",
          checkedAt: 2,
          projectMode: "auto",
          effective: "local",
        },
      }),
    );
    render();
    await settle();

    expect(calls("GET", `/api/sandbox/status?projectId=${PROJECT}`)).toHaveLength(1);
    const hint = document.querySelector("[data-effective-mode-hint]");
    expect(hint?.textContent).toBe("effective: local (Docker unavailable)");

    // The hint follows the select live: switching to local while docker is
    // down names the policy as the reason (no fallback claim).
    setSelect("policy-execution-mode", "local");
    await settle();
    expect(document.querySelector("[data-effective-mode-hint]")?.textContent).toBe(
      "effective: local (policy: local)",
    );
  });

  it("shows the detected-sandbox hint when docker is up", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}`]: {
          project: { sandboxPolicy: { executionMode: "auto" } },
        },
      }),
    );
    render();
    await settle();

    expect(document.querySelector("[data-effective-mode-hint]")?.textContent).toBe(
      "effective: sandbox (Docker detected)",
    );
  });

  it("omits the hint when the docker status cannot be resolved", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/sandbox/status?projectId=${PROJECT}`]: {
          status: 503,
          body: { error: { code: "SANDBOX_UNAVAILABLE", message: "no provider" } },
        },
      }),
    );
    render();
    await settle();

    expect(document.querySelector("[data-effective-mode-hint]")).toBeNull();
  });
});

describe("ProjectSettingsDrawer worktrees pane (#111)", () => {
  const KB = 1024;
  const hoursAgo = (hours: number): string =>
    new Date(Date.now() - hours * 3_600_000).toISOString();

  const rows = {
    worktrees: [
      {
        runId: "run-live",
        branch: "agentloop/run-live",
        path: "/store/run-live",
        diskUsageBytes: 900 * KB,
        lastActivity: hoursAgo(1),
        status: "active",
        runStatus: "running",
      },
      {
        runId: "run-done",
        branch: "agentloop/run-done",
        path: "/store/run-done",
        diskUsageBytes: 300 * KB,
        lastActivity: hoursAgo(3),
        status: "inspectable",
        runStatus: "success",
      },
      {
        runId: "run-orphan",
        branch: "agentloop/run-orphan",
        path: "/store/run-orphan",
        diskUsageBytes: 100 * KB,
        lastActivity: hoursAgo(26),
        status: "orphan",
      },
    ],
    totalBytes: 1300 * KB,
  };

  const row = (runId: string): HTMLElement =>
    document.querySelector(`[data-worktree-row="${runId}"]`) as HTMLElement;

  const usageValue = (runId: string): string | null =>
    row(runId)?.querySelector("[data-worktree-usage]")?.getAttribute("aria-valuenow") ?? null;

  it("renders rows with mono branches, status badges, usage bars, relative activity and totals", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: rows,
      }),
    );
    render();
    await settle();

    expect(row("run-live")).not.toBeNull();
    expect(row("run-done").getAttribute("data-worktree-status")).toBe("inspectable");
    expect(row("run-orphan").getAttribute("data-worktree-status")).toBe("orphan");
    for (const branch of rows.worktrees.map((entry) => entry.branch)) {
      expect(text()).toContain(branch);
    }
    expect(text()).toContain("Active");
    expect(text()).toContain("Inspectable");
    expect(text()).toContain("Orphan");

    // Bars share one scale: the largest worktree is full width.
    expect(usageValue("run-live")).toBe("100");
    expect(usageValue("run-done")).toBe("33");
    expect(usageValue("run-orphan")).toBe("11");

    expect(text()).toContain("1.3 MB");
    expect(text()).toContain("3 worktrees");
    expect(text()).toContain("1 orphaned");
    expect(text()).toContain("3h ago");
    expect(text()).toContain("1d ago");

    // Inspect links exist only for rows with a run behind them.
    expect(document.querySelector('a[href="/runs/run-live"]')).not.toBeNull();
    expect(document.querySelector('a[href="/runs/run-done"]')).not.toBeNull();
    expect(document.querySelector('a[href="/runs/run-orphan"]')).toBeNull();
  });

  it("never offers prune on an active worktree", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: {
          worktrees: [rows.worktrees[0]],
          totalBytes: 900 * KB,
        },
      }),
    );
    render();
    await settle();

    expect(button("Prune run-live")).toBeUndefined();
    // Bulk action renders but is disabled with zero orphans.
    expect(button("Prune all orphans")?.disabled).toBe(true);
  });

  it("shows the empty state when the project has no worktrees", async () => {
    installRoutes(mountRoutes());
    render();
    await settle();
    expect(text()).toContain("No worktrees yet");
  });

  it("copy path writes the worktree path to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: rows,
      }),
    );
    render();
    await settle();

    act(() => button("Copy path")?.click());
    await settle();

    expect(writeText).toHaveBeenCalledWith("/store/run-live");
    expect(text()).toContain("Worktree path copied");
  });

  it("prunes a selected orphan only after the confirm click, then refreshes", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: [
          rows,
          { worktrees: [rows.worktrees[0], rows.worktrees[1]], totalBytes: 1200 * KB },
        ],
        [`POST /api/projects/${PROJECT}/worktrees/prune`]: {
          removed: [{ runId: "run-orphan", path: "/store/run-orphan" }],
          kept: 2,
        },
      }),
    );
    render();
    await settle();

    act(() => button("Prune run-orphan")?.click());
    await settle();
    expect(calls("POST", `/api/projects/${PROJECT}/worktrees/prune`)).toHaveLength(0);

    act(() => button("Confirm prune run-orphan")?.click());
    await settle();

    const post = calls("POST", `/api/projects/${PROJECT}/worktrees/prune`);
    expect(post[0]?.[1]?.body).toBe(JSON.stringify({ runId: "run-orphan" }));
    expect(text()).toContain("Pruned run-orphan");
    // Refreshed listing: the orphan row is gone.
    expect(row("run-orphan")).toBeNull();
    expect(row("run-live")).not.toBeNull();
  });

  it("prunes all orphans via the bulk action confirm", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: [
          rows,
          { worktrees: rows.worktrees.slice(0, 2), totalBytes: 1200 * KB },
        ],
        [`POST /api/projects/${PROJECT}/worktrees/prune`]: {
          removed: [{ runId: "run-orphan", path: "/store/run-orphan" }],
          kept: 2,
        },
      }),
    );
    render();
    await settle();

    act(() => button("Prune all orphans")?.click());
    await settle();
    expect(calls("POST", `/api/projects/${PROJECT}/worktrees/prune`)).toHaveLength(0);

    act(() => button("Confirm prune all orphaned worktrees")?.click());
    await settle();

    const post = calls("POST", `/api/projects/${PROJECT}/worktrees/prune`);
    expect(post[0]?.[1]?.body).toBe(JSON.stringify({ orphans: true }));
    expect(text()).toContain("Pruned run-orphan");
    expect(row("run-orphan")).toBeNull();
  });

  it("surfaces a daemon 409 WORKTREE_ACTIVE as a danger toast", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: rows,
        [`POST /api/projects/${PROJECT}/worktrees/prune`]: {
          status: 409,
          body: {
            error: {
              code: "WORKTREE_ACTIVE",
              message: "run run-done is still running; its worktree cannot be pruned yet",
            },
          },
        },
      }),
    );
    render();
    await settle();

    // The daemon is the guard of record: a row the UI believed prunable can
    // still answer 409 (e.g. the run restarted underneath the listing).
    act(() => button("Prune run-done")?.click());
    await settle();
    act(() => button("Confirm prune run-done")?.click());
    await settle();

    expect(text()).toContain("Could not prune worktree");
    expect(text()).toContain("cannot be pruned yet");
  });

  it("surfaces prune cleanup warnings in the toast", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: rows,
        [`POST /api/projects/${PROJECT}/worktrees/prune`]: {
          removed: [
            {
              runId: "run-orphan",
              path: "/store/run-orphan",
              warnings: ["failed to delete branch agentloop/run-orphan"],
            },
          ],
          kept: 2,
        },
      }),
    );
    render();
    await settle();

    act(() => button("Prune run-orphan")?.click());
    await settle();
    act(() => button("Confirm prune run-orphan")?.click());
    await settle();

    expect(text()).toContain("cleanup warning");
  });

  it("shows a retry affordance when the listing fails to load", async () => {
    installRoutes(
      mountRoutes({
        [`GET /api/projects/${PROJECT}/worktrees`]: {
          status: 500,
          body: { error: { code: "INTERNAL_ERROR", message: "boom" } },
        },
      }),
    );
    render();
    await settle();

    expect(text()).toContain("Could not load worktrees");
    expect(button("Retry")).toBeDefined();
  });
});
