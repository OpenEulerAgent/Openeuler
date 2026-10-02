// @vitest-environment jsdom
//
// Project settings drawer (#93): secrets pane wiring. The list renders
// names + created dates only — a value column must never exist. Add calls
// PUT, delete needs a confirm click then calls DELETE, and outcomes land
// as toasts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ProjectSettingsDrawer } from "./ProjectSettingsDrawer";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const fetchMock = vi.fn();

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(
        ToastProvider,
        null,
        createElement(ProjectSettingsDrawer, { projectId: "p1", onClose: () => {} }) as ReactNode,
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

const setInput = (id: string, value: string): void => {
  const input = document.getElementById(id) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  // React 19 controlled input: set via the native setter then dispatch.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const submitForm = (): void => {
  const form = document.querySelector("form");
  expect(form).not.toBeNull();
  act(() => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("ProjectSettingsDrawer secrets pane (#93)", () => {
  it("lists names + created dates only — never values", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        secrets: [
          { name: "NPM_TOKEN", createdAt: "2026-01-01T00:00:00.000Z" },
          { name: "API_KEY", createdAt: "2026-02-02T00:00:00.000Z" },
        ],
      }),
    );
    render();
    await settle();

    expect(text()).toContain("NPM_TOKEN");
    expect(text()).toContain("API_KEY");
    expect(text()).not.toContain("No secrets yet");
    // The listing response never carried values; nothing echoes them either.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8787/api/projects/p1/secrets");
  });

  it("shows the empty state when the project has no secrets", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ secrets: [] }));
    render();
    await settle();
    expect(text()).toContain("No secrets yet");
  });

  it("adds a secret: PUT with name+value, toast, refreshed list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ secrets: [] }));
    render();
    await settle();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ secret: { name: "NPM_TOKEN", createdAt: "x" } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ secrets: [{ name: "NPM_TOKEN", createdAt: "x" }] }),
    );

    setInput("secret-name", "NPM_TOKEN");
    setInput("secret-value", "npat_super_secret_1");
    submitForm();
    await settle();

    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put?.[0]).toBe("http://localhost:8787/api/projects/p1/secrets");
    expect(put?.[1]?.body).toBe(
      JSON.stringify({ name: "NPM_TOKEN", value: "npat_super_secret_1" }),
    );
    expect(text()).toContain("Saved NPM_TOKEN");
    // The typed value is never rendered anywhere after submit.
    expect(text()).not.toContain("npat_super_secret_1");
    // And the form cleared.
    expect((document.getElementById("secret-value") as HTMLInputElement)?.value).toBe("");
  });

  it("blocks an invalid name client-side with the env-var rule message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ secrets: [] }));
    render();
    await settle();

    setInput("secret-name", "bad-name");
    setInput("secret-value", "some-value-1");
    submitForm();
    await settle();

    expect(text()).toMatch(/secret name must match/);
    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put).toBeUndefined();
  });

  it("delete requires a confirm click, then DELETEs and toasts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ secrets: [{ name: "NPM_TOKEN", createdAt: "x" }] }),
    );
    render();
    await settle();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ secrets: [] }));

    act(() => button("Delete NPM_TOKEN")?.click());
    await settle();
    // Not deleted yet — the confirm pair replaced the row actions.
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(0);

    act(() => button("Confirm delete NPM_TOKEN")?.click());
    await settle();

    expect(fetchMock.mock.calls.find((call) => call[1]?.method === "DELETE")?.[0]).toBe(
      "http://localhost:8787/api/projects/p1/secrets/NPM_TOKEN",
    );
    expect(text()).toContain("Deleted NPM_TOKEN");
  });

  it("surfaces a daemon 422 on save as a danger toast", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ secrets: [] }));
    render();
    await settle();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "secret name must match ^[A-Z_][A-Z0-9_]*$",
          },
        },
        422,
      ),
    );

    setInput("secret-name", "OK_NAME");
    setInput("secret-value", "v-123456");
    submitForm();
    await settle();

    expect(text()).toContain("Could not save secret");
  });

  it("explains when the daemon has no secret key (SECRETS_UNAVAILABLE)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "SECRETS_UNAVAILABLE", message: "no key" } }, 503),
    );
    render();
    await settle();

    expect(text()).toContain("no secret key loaded");
    // The save button is disabled in that mode.
    const save = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save secret"),
    );
    expect(save?.disabled).toBe(true);
  });
});
