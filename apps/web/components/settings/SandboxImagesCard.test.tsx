// @vitest-environment jsdom
//
// Settings → Sandbox section (#100): catalog table render, pull/build form
// flows driving daemon jobs (inline progress row → poll → refresh + toast),
// delete with confirm dialog, 409 IMAGE_IN_USE surfacing and the load-failure
// retry card — all against a mocked fetch (the job endpoint is stateful).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { SandboxImagesCard } from "./SandboxImagesCard";
import type { SandboxImageEntry } from "@/lib/sandbox-api";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const images: SandboxImageEntry[] = [
  {
    repository: "openeuler/worker",
    tag: "latest",
    id: "sha256:aaa",
    sizeBytes: 12_500_000,
    createdAt: Date.now() - 3_600_000,
    ours: true,
  },
  {
    repository: "busybox",
    tag: "musl",
    id: "sha256:bbb",
    sizeBytes: 4_161_792,
    createdAt: Date.now() - 86_400_000,
    ours: false,
  },
];

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Call {
  method: string;
  url: string;
  body?: string;
}

const calls: Call[] = [];
/** Job responses per test; consumed FIFO by GET /api/sandbox/jobs/:id. */
let jobResponses: Array<Record<string, unknown>> = [];
let pullResponse: () => Response = () => jsonResponse({ jobId: "job-pull" }, 202);
let buildResponse: () => Response = () =>
  jsonResponse({ jobId: "job-build", tag: "openeuler/worker:latest" }, 202);
let deleteResponse: () => Response = () => jsonResponse({ deleted: "x" });

const stubFetch = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: path,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (path.includes("/api/sandbox/images/pull") && method === "POST") {
        return pullResponse();
      }
      if (path.includes("/api/sandbox/images/build") && method === "POST") {
        return buildResponse();
      }
      if (path.includes("/api/sandbox/jobs/")) {
        return jsonResponse(
          jobResponses.shift() ?? { id: "x", kind: "pull", ref: "r", status: "done", createdAt: 1 },
        );
      }
      if (path.includes("/api/sandbox/images/") && method === "DELETE") {
        return deleteResponse();
      }
      return jsonResponse({ images });
    }),
  );
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(ToastProvider, null, createElement(SandboxImagesCard))));
};

const settle = async (ms = 0, turns = 5): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
};

const text = (): string => document.body.textContent ?? "";

const buttons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")] as HTMLButtonElement[];

const button = (label: string): HTMLButtonElement | undefined =>
  buttons().find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );

const setInputValue = (id: string, value: string): void => {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(input).not.toBeNull();
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const catalogCalls = (): Call[] =>
  calls.filter((call) => call.url.includes("/api/sandbox/images") && call.method === "GET");

const postBody = (fragment: string): Record<string, unknown> | undefined => {
  const call = calls.find((c) => c.url.includes(fragment) && c.method === "POST" && c.body);
  return call === undefined
    ? undefined
    : (JSON.parse(call.body as string) as Record<string, unknown>);
};

beforeEach(() => {
  calls.length = 0;
  jobResponses = [];
  pullResponse = () => jsonResponse({ jobId: "job-pull" }, 202);
  buildResponse = () => jsonResponse({ jobId: "job-build", tag: "openeuler/worker:latest" }, 202);
  deleteResponse = () => jsonResponse({ deleted: "x" });
  stubFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("catalog table (#100)", () => {
  it("renders repo:tag, size, relative age and the ours badge", async () => {
    render();
    await settle();

    expect(text()).toContain("openeuler/worker:latest");
    expect(text()).toContain("busybox:musl");
    expect(text()).toContain("11.9 MB"); // 12_500_000 bytes (decimal)
    expect(text()).toContain("ours");
    expect(text()).toContain("base");
    expect(text()).toContain("1h ago");
    expect(text()).toContain("1d ago");
    expect(button("Delete openeuler/worker:latest")).toBeDefined();
  });

  it("shows the empty state when the catalog is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ images: [] })),
    );
    render();
    await settle();
    expect(text()).toContain("No catalog images yet");
  });

  it("shows an error card with retry when the catalog request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    render();
    await settle();
    expect(text()).toContain("Could not load sandbox images");

    stubFetch();
    calls.length = 0;
    act(() => button("Retry")?.click());
    await settle();
    expect(text()).toContain("openeuler/worker:latest");
  });
});

describe("pull flow (#100)", () => {
  it("POSTs the ref, polls the job to done, then refreshes and toasts", async () => {
    jobResponses = [
      { id: "job-pull", kind: "pull", ref: "busybox:musl", status: "running", createdAt: 1 },
      {
        id: "job-pull",
        kind: "pull",
        ref: "busybox:musl",
        status: "done",
        createdAt: 1,
        finishedAt: 2,
      },
    ];
    render();
    await settle();
    calls.length = 0;

    setInputValue("sandbox-pull-ref", "busybox:musl");
    act(() => button("Pull image")?.click());
    // First poll answers "running": the inline progress row is visible.
    await settle(0, 2);
    expect(text()).toContain("Pulling busybox:musl…");
    // The next poll fires after the 1s poll interval and answers "done".
    await settle(1_100, 1);

    expect(postBody("/api/sandbox/images/pull")).toEqual({ ref: "busybox:musl" });
    expect(text()).toContain("Pulled busybox:musl");
    // Job row is gone and the catalog was refreshed.
    expect(catalogCalls().length).toBeGreaterThan(0);
    expect(text()).not.toContain("Pulling busybox:musl…");
  });

  it("disables the pull button for an empty ref and surfaces job failures", async () => {
    render();
    await settle();
    expect(button("Pull image")?.disabled).toBe(true);

    jobResponses = [
      {
        id: "job-pull",
        kind: "pull",
        ref: "nope/nope",
        status: "failed",
        error: "manifest unknown",
        createdAt: 1,
      },
    ];
    setInputValue("sandbox-pull-ref", "nope/nope");
    act(() => button("Pull image")?.click());
    await settle();

    expect(text()).toContain("Pulling nope/nope failed");
    expect(text()).toContain("manifest unknown");
  });

  it("surfaces a rejected pull start as a danger toast", async () => {
    pullResponse = () =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "bad ref shape" } }, 422);
    render();
    await settle();

    setInputValue("sandbox-pull-ref", "NOT A REF");
    act(() => button("Pull image")?.click());
    await settle();

    expect(text()).toContain("Failed to start job");
    expect(text()).toContain("bad ref shape");
  });
});

describe("build flow (#100)", () => {
  it("POSTs name + dockerfile, polls the job, refreshes and toasts", async () => {
    jobResponses = [
      {
        id: "job-build",
        kind: "build",
        ref: "openeuler/test:latest",
        status: "done",
        createdAt: 1,
        finishedAt: 2,
      },
    ];
    buildResponse = () => jsonResponse({ jobId: "job-build", tag: "openeuler/test:latest" }, 202);
    render();
    await settle();
    calls.length = 0;

    setInputValue("sandbox-build-name", "test");
    setInputValue("sandbox-build-dockerfile", "FROM alpine:3.20\nRUN echo hi\n");
    act(() => button("Build image")?.click());
    await settle();

    expect(postBody("/api/sandbox/images/build")).toEqual({
      name: "test",
      // The component trims surrounding whitespace before sending.
      dockerfileText: "FROM alpine:3.20\nRUN echo hi",
    });
    expect(text()).toContain("Built openeuler/test:latest");
    expect(catalogCalls().length).toBeGreaterThan(0);
  });

  it("sends only baseRef when the Dockerfile is empty", async () => {
    jobResponses = [
      {
        id: "job-build",
        kind: "build",
        ref: "openeuler/test:latest",
        status: "done",
        createdAt: 1,
      },
    ];
    render();
    await settle();
    calls.length = 0;

    setInputValue("sandbox-build-name", "test");
    setInputValue("sandbox-build-base", "alpine:3.20");
    act(() => button("Build image")?.click());
    await settle();

    expect(postBody("/api/sandbox/images/build")).toEqual({ name: "test", baseRef: "alpine:3.20" });
  });

  it("keeps the build button disabled for invalid input", async () => {
    render();
    await settle();
    expect(button("Build image")?.disabled).toBe(true); // nothing filled

    setInputValue("sandbox-build-name", "Bad Name");
    setInputValue("sandbox-build-dockerfile", "FROM alpine\n");
    expect(button("Build image")?.disabled).toBe(true); // invalid name

    setInputValue("sandbox-build-name", "good-name");
    expect(button("Build image")?.disabled).toBe(false);
  });
});

describe("delete flow (#100)", () => {
  it("confirms in a dialog, DELETEs the encoded ref and refreshes", async () => {
    render();
    await settle();
    calls.length = 0;

    act(() => button("Delete openeuler/worker:latest")?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain("Delete image");

    act(() => button("Confirm delete")?.click());
    await settle();

    const del = calls.find((call) => call.method === "DELETE");
    expect(del?.url).toContain("/api/sandbox/images/openeuler%2Fworker%3Alatest");
    expect(text()).toContain("Deleted openeuler/worker:latest");
    expect(catalogCalls().length).toBeGreaterThan(0);
  });

  it("cancel closes the dialog without deleting", async () => {
    render();
    await settle();
    calls.length = 0;

    act(() => button("Delete busybox:musl")?.click());
    act(() => button("Cancel")?.click());
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("surfaces a 409 IMAGE_IN_USE rejection as a danger toast", async () => {
    deleteResponse = () =>
      jsonResponse(
        {
          error: {
            code: "IMAGE_IN_USE",
            message: 'image "openeuler/worker:latest" is used by 1 sandbox',
          },
        },
        409,
      );
    render();
    await settle();

    act(() => button("Delete openeuler/worker:latest")?.click());
    act(() => button("Confirm delete")?.click());
    await settle();

    expect(text()).toContain("Image is in use");
    expect(text()).toContain("is used by 1 sandbox");
  });
});
