// @vitest-environment jsdom
//
// Project settings drawer (#93 secrets, #101 sandbox policy). Secrets pane:
// the list renders names + created dates only — a value column must never
// exist; add calls PUT, delete needs a confirm click. Sandbox pane: loads
// the saved policy + image catalog, PATCHes the whole policy, shows inline
// validation errors and the "limited does not filter egress" honesty note.

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

/** Default mount routes: empty project policy, empty catalog, secrets list. */
function mountRoutes(extra: RouteSpec = {}): RouteSpec {
  return {
    [`GET /api/projects/${PROJECT}`]: { project: {} },
    "GET /api/sandbox/images": { images: [] },
    [`GET /api/projects/${PROJECT}/secrets`]: { secrets: [] },
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
});
