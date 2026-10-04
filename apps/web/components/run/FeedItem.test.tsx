// @vitest-environment jsdom
//
// FeedItem sandbox log rendering (#104): `sandbox.log` events render as
// quiet mono gray lines (stderr gets a `[stderr]` prefix in warning tone),
// and the `sandbox.log-truncated` marker renders a warning system line with
// the kept/dropped counts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedEntry } from "@/lib/run-feed";
import { FeedItem } from "./FeedItem";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const render = async (entry: FeedEntry): Promise<HTMLElement> => {
  await act(async () => {
    root?.render(<FeedItem entry={entry} />);
  });
  return container as HTMLElement;
};

describe("FeedItem: sandbox.log (#104)", () => {
  it("renders stdout lines as mono gray text", async () => {
    const el = await render({
      kind: "event",
      id: "seq-1",
      event: {
        type: "sandbox.log",
        seq: 1,
        sandboxId: "sb-1",
        stream: "stdout",
        line: "make[1]: entering directory '/workspace'",
      },
    });
    const line = el.querySelector("p");
    expect(line?.textContent).toBe("make[1]: entering directory '/workspace'");
    expect(line?.className).toContain("font-mono");
    expect(line?.className).toContain("text-muted-fg");
  });

  it("prefixes stderr lines and tones them as warnings", async () => {
    const el = await render({
      kind: "event",
      id: "seq-2",
      event: {
        type: "sandbox.log",
        seq: 2,
        sandboxId: "sb-1",
        stream: "stderr",
        line: "warning: implicit conversion",
      },
    });
    const line = el.querySelector("p");
    expect(line?.textContent).toBe("[stderr] warning: implicit conversion");
    expect(line?.className).toContain("text-warning");
  });

  it("renders the truncation marker with kept/dropped counts", async () => {
    const el = await render({
      kind: "event",
      id: "seq-3",
      event: {
        type: "sandbox.log-truncated",
        seq: 3,
        sandboxId: "sb-1",
        dropped: 100,
        kept: 2000,
      },
    });
    const line = el.querySelector("p");
    expect(line?.textContent).toContain("sandbox logs truncated");
    expect(line?.textContent).toContain("last 2000");
    expect(line?.textContent).toContain("2100");
    expect(line?.textContent).toContain("100 dropped");
  });
});

describe("FeedItem: node.retry (#119)", () => {
  it("renders the retried attempt with its backoff delay and next attempt", async () => {
    const el = await render({
      kind: "event",
      id: "seq-4",
      event: {
        type: "node.retry",
        seq: 4,
        nodeId: "a",
        nodeName: "implement",
        iteration: 1,
        attempt: 1,
        nextInMs: 200,
        error: "agent exited with code 1",
      },
    });
    const line = el.querySelector("p");
    expect(line?.textContent).toContain("node implement attempt 1 retried");
    expect(line?.textContent).toContain("agent exited with code 1");
    expect(line?.textContent).toContain("next attempt in 200ms (attempt 2)");
  });

  it("renders retryOn 'always' events without an error clause", async () => {
    const el = await render({
      kind: "event",
      id: "seq-5",
      event: {
        type: "node.retry",
        seq: 5,
        nodeId: "a",
        nodeName: "implement",
        iteration: 1,
        attempt: 1,
        nextInMs: 100,
      },
    });
    const line = el.querySelector("p");
    expect(line?.textContent).toContain("attempt 1 retried");
    expect(line?.textContent).not.toContain("undefined");
  });
});
