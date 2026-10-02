import { describe, expect, it } from "vitest";
import type { CanvasDocument } from "./canvas-document";
import {
  CANVAS_HINTS_STORAGE_KEY,
  docHasConfiguredPrompt,
  loadDismissedCanvasHints,
  saveDismissedCanvasHints,
  visibleCanvasHints,
  type CanvasHintStorage,
} from "./canvas-hints";

/** In-memory Storage stub (the round-trip persistence surface). */
function memoryStorage(initial: Record<string, string> = {}): CanvasHintStorage & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("visibleCanvasHints (#77)", () => {
  it("fresh canvas (entry node only): the drag hint", () => {
    const hints = visibleCanvasHints({
      nodeCount: 1,
      connectedOnce: false,
      hasConfiguredPrompt: false,
      dismissed: [],
    });
    expect(hints).toEqual([{ id: "drag", message: "Drag an Agent step from the palette" }]);
  });

  it("empty canvas with an earlier connection adds the ⌘S save note", () => {
    const hints = visibleCanvasHints({
      nodeCount: 1,
      connectedOnce: true,
      hasConfiguredPrompt: false,
      dismissed: [],
    });
    expect(hints).toEqual([
      {
        id: "drag",
        message: "Drag an Agent step from the palette",
        saveNote: "then ⌘/Ctrl+S to save",
      },
    ]);
  });

  it("two nodes, no edges: connect comes before configure", () => {
    const hints = visibleCanvasHints({
      nodeCount: 2,
      connectedOnce: false,
      hasConfiguredPrompt: false,
      dismissed: [],
    });
    expect(hints.map((hint) => hint.id)).toEqual(["connect", "configure"]);
    expect(hints[0]?.message).toBe("Drag from a node's handle to connect the flow");
    expect(hints[1]?.message).toBe("Click a node to configure its prompt");
  });

  it("connected flow with default prompts: only configure", () => {
    const hints = visibleCanvasHints({
      nodeCount: 3,
      connectedOnce: true,
      hasConfiguredPrompt: false,
      dismissed: [],
    });
    expect(hints.map((hint) => hint.id)).toEqual(["configure"]);
  });

  it("configured prompt clears the last hint — graduation", () => {
    const hints = visibleCanvasHints({
      nodeCount: 3,
      connectedOnce: true,
      hasConfiguredPrompt: true,
      dismissed: [],
    });
    expect(hints).toEqual([]);
  });

  it("dismissed ids drop exactly their hints; the rest survive", () => {
    const hints = visibleCanvasHints({
      nodeCount: 2,
      connectedOnce: false,
      hasConfiguredPrompt: false,
      dismissed: ["connect"],
    });
    expect(hints.map((hint) => hint.id)).toEqual(["configure"]);

    const onlyDragLeft = visibleCanvasHints({
      nodeCount: 1,
      connectedOnce: false,
      hasConfiguredPrompt: false,
      dismissed: ["drag"],
    });
    expect(onlyDragLeft).toEqual([]);
  });

  it("unknown dismissed ids are harmless", () => {
    const hints = visibleCanvasHints({
      nodeCount: 1,
      connectedOnce: false,
      hasConfiguredPrompt: false,
      dismissed: ["nonsense", "configure"],
    });
    expect(hints.map((hint) => hint.id)).toEqual(["drag"]);
  });
});

describe("docHasConfiguredPrompt (#77)", () => {
  const doc = (prompts: string[]): CanvasDocument => ({
    nodes: prompts.map((promptTemplate, index) => ({
      id: `n${index}`,
      type: "agent",
      position: { x: 0, y: 0 },
      data: {
        kind: "agent",
        name: "Agent",
        isEntry: index === 0,
        config: {
          driver: "opencode",
          mode: "auto",
          promptTemplate,
          continueSession: false,
        },
      },
    })),
    edges: [],
  });

  it("starter and palette-default prompts read as unconfigured", () => {
    expect(docHasConfiguredPrompt(doc(["{{task}}"]))).toBe(false);
    expect(docHasConfiguredPrompt(doc(["Work on the following task:\n\n{{task}}"]))).toBe(false);
  });

  it("any drifted prompt reads as configured; padded defaults still don't", () => {
    expect(docHasConfiguredPrompt(doc(["{{task}}", "Review: {{task}}"]))).toBe(true);
    expect(docHasConfiguredPrompt(doc(["  {{task}}  "]))).toBe(false);
    expect(docHasConfiguredPrompt(doc(["  Review: {{task}}  "]))).toBe(true);
  });
});

describe("hint dismissal persistence (#77)", () => {
  it("round-trips through localStorage", () => {
    const storage = memoryStorage();
    saveDismissedCanvasHints(storage, ["drag", "configure"]);
    expect(storage.store.get(CANVAS_HINTS_STORAGE_KEY)).toBe('["drag","configure"]');
    expect(loadDismissedCanvasHints(storage)).toEqual(["drag", "configure"]);

    saveDismissedCanvasHints(storage, []);
    expect(loadDismissedCanvasHints(storage)).toEqual([]);
  });

  it("pre-seeded storage loads on first read", () => {
    const storage = memoryStorage({ [CANVAS_HINTS_STORAGE_KEY]: '["connect"]' });
    expect(loadDismissedCanvasHints(storage)).toEqual(["connect"]);
  });

  it("junk payloads degrade to nothing dismissed", () => {
    expect(
      loadDismissedCanvasHints(memoryStorage({ [CANVAS_HINTS_STORAGE_KEY]: "not json" })),
    ).toEqual([]);
    expect(
      loadDismissedCanvasHints(memoryStorage({ [CANVAS_HINTS_STORAGE_KEY]: '{"drag":true}' })),
    ).toEqual([]);
    expect(
      loadDismissedCanvasHints(memoryStorage({ [CANVAS_HINTS_STORAGE_KEY]: '[1, null, "ok"]' })),
    ).toEqual(["ok"]);
  });

  it("null storage (SSR) reads empty and writes nothing", () => {
    expect(loadDismissedCanvasHints(null)).toEqual([]);
    expect(() => saveDismissedCanvasHints(null, ["drag"])).not.toThrow();
  });

  it("a throwing storage surface stays quiet", () => {
    const throwing: CanvasHintStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadDismissedCanvasHints(throwing)).toEqual([]);
    expect(() => saveDismissedCanvasHints(throwing, ["drag"])).not.toThrow();
  });
});
