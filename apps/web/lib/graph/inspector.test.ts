import { describe, expect, it } from "vitest";
import {
  canvasDocsEquivalent,
  createAgentNode,
  createExitNode,
  fromCanvasDocument,
  type CanvasDocument,
  type CanvasNode,
} from "./canvas-document";
import {
  PREVIEW_SAMPLE_PREV_OUTPUT,
  PREVIEW_SAMPLE_TASK,
  applyInspectorAction,
  insertPromptVariable,
  inspectorFieldErrors,
  inspectorReducer,
  previewPromptTemplate,
  upstreamNodes,
} from "./inspector";

function node(
  id: string,
  options: {
    isEntry?: boolean;
    name?: string;
    promptTemplate?: string;
    model?: string;
    mode?: "auto" | "ask";
    continueSession?: boolean;
    position?: { x: number; y: number };
  } = {},
): CanvasNode {
  const base = createAgentNode({
    id,
    isEntry: options.isEntry ?? false,
    position: options.position ?? { x: 0, y: 0 },
  });
  if (base.data.kind !== "agent") throw new Error("expected an agent node");
  return {
    ...base,
    data: {
      ...base.data,
      name: options.name ?? id,
      config: {
        ...base.data.config,
        promptTemplate: options.promptTemplate ?? "work: {{task}}",
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.continueSession === undefined
          ? {}
          : { continueSession: options.continueSession }),
      },
    },
  };
}

function exit(id: string, position = { x: 900, y: 0 }): CanvasNode {
  return { ...createExitNode(position), id, data: { kind: "exit", name: "Exit" } };
}

function edge(
  source: string,
  target: string,
  condition: "always" | { pattern: string } = "always",
): CanvasDocument["edges"][number] {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    data: {
      condition:
        condition === "always"
          ? { type: "always" }
          : { type: "outputContains", pattern: condition.pattern },
    },
  };
}

describe("upstreamNodes", () => {
  it("lists every node of a chain in document order", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: 0 } }),
        node("c", { position: { x: 600, y: 0 } }),
      ],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    expect(upstreamNodes(doc, "c").map((candidate) => candidate.id)).toEqual(["a", "b"]);
    expect(upstreamNodes(doc, "b").map((candidate) => candidate.id)).toEqual(["a"]);
    expect(upstreamNodes(doc, "a")).toEqual([]);
  });

  it("covers both branches of a diamond", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: -120 } }),
        node("c", { position: { x: 300, y: 120 } }),
        node("d", { position: { x: 600, y: 0 } }),
      ],
      edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    };
    expect(upstreamNodes(doc, "d").map((candidate) => candidate.id)).toEqual(["a", "b", "c"]);
  });

  it("follows loop edges but excludes the node itself and downstream nodes", () => {
    // a → b ⇄ (loop back to a): upstream of a includes b via the loop edge.
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } })],
      edges: [edge("a", "b"), edge("b", "a", { pattern: "retry" })],
    };
    expect(upstreamNodes(doc, "a").map((candidate) => candidate.id)).toEqual(["b"]);
    expect(upstreamNodes(doc, "b").map((candidate) => candidate.id)).toEqual(["a"]);
  });

  it("never includes the node itself, even through longer cycles", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", { position: { x: 300, y: 0 } }),
        node("c", { position: { x: 600, y: 0 } }),
      ],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "a", { pattern: "loop" })],
    };
    for (const id of ["a", "b", "c"]) {
      const upstream = upstreamNodes(doc, id).map((candidate) => candidate.id);
      expect(upstream).not.toContain(id);
    }
    expect(
      upstreamNodes(doc, "a")
        .map((candidate) => candidate.id)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("returns [] for unknown nodes", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [edge("a", "x")],
    };
    expect(upstreamNodes(doc, "ghost")).toEqual([]);
  });
});

describe("insertPromptVariable", () => {
  it("inserts at the caret and reports the post-token caret", () => {
    expect(insertPromptVariable("Do  now", "{{task}}", 3)).toEqual({
      template: "Do {{task}} now",
      caret: 11,
    });
  });

  it("appends when the caret is at the end", () => {
    expect(insertPromptVariable("Do ", "{{task}}", 99)).toEqual({
      template: "Do {{task}}",
      caret: 11,
    });
  });

  it("clamps a negative caret to 0", () => {
    expect(insertPromptVariable("go", "{{task}}", -5)).toEqual({
      template: "{{task}}go",
      caret: 8,
    });
  });
});

describe("previewPromptTemplate", () => {
  const upstream = [
    { id: "implement", name: "Implement" },
    { id: "review", name: "Review" },
  ];

  it("renders against the sample task, iteration 1, and dummy upstream outputs", () => {
    const preview = previewPromptTemplate(
      "Task {{task}} (pass {{iterations}}), then check {{output:implement}} / {{prevOutput}}",
      upstream,
    );
    expect(preview).toEqual({
      ok: true,
      text: `Task ${PREVIEW_SAMPLE_TASK} (pass 1), then check <output of "Implement"> / ${PREVIEW_SAMPLE_PREV_OUTPUT}`,
    });
  });

  it("shows the friendly error inline for an unresolved {{output:…}} reference", () => {
    const preview = previewPromptTemplate("Use {{output:ghost}}", upstream);
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.error).toContain("{{output:ghost}}");
      expect(preview.error).toContain("available: implement, review");
    }
  });

  it("shows the friendly error for an unknown variable", () => {
    const preview = previewPromptTemplate("Use {{nope}}", upstream);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toContain("Unknown prompt template variable");
  });

  it("updates live while typing (each keystroke renders the current template)", () => {
    const final = "Use {{task}} and {{output:implement}}";
    const previews: string[] = [];
    for (let length = 0; length <= final.length; length += 1) {
      const preview = previewPromptTemplate(final.slice(0, length), upstream);
      expect(preview.ok).toBe(true);
      if (preview.ok) previews.push(preview.text);
    }
    // Mid-typing the partial token renders literally; the finished template
    // renders fully — the preview tracks every keystroke.
    expect(previews[previews.length - 1]).toBe(
      `Use ${PREVIEW_SAMPLE_TASK} and <output of "Implement">`,
    );
    expect(previews[previews.length - 2]).toContain("{{output:implement");
  });

  it("honors overrides for the sample vars", () => {
    const preview = previewPromptTemplate("{{task}} #{{iterations}}", [], {
      task: "custom task",
      iterations: 4,
    });
    expect(preview).toEqual({ ok: true, text: "custom task #4" });
  });
});

describe("inspectorFieldErrors", () => {
  it("flags an empty name with the schema message", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true, name: "" })],
      edges: [],
    };
    expect(inspectorFieldErrors(doc, "a")["name"]).toContain("non-empty");
  });

  it("flags an empty prompt template with the schema message", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true, promptTemplate: "" })],
      edges: [],
    };
    expect(inspectorFieldErrors(doc, "a")["config.promptTemplate"]).toContain(
      "promptTemplate must be a non-empty string",
    );
  });

  it("flags an invalid model string", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true, model: "" })],
      edges: [],
    };
    expect(inspectorFieldErrors(doc, "a")["config.model"]).toBeDefined();
  });

  it("flags a non-upstream {{output:…}} reference on the prompt field", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", {
          promptTemplate: "use {{output:ghost}} and {{output:a}}",
          position: { x: 300, y: 0 },
        }),
      ],
      edges: [edge("a", "b")],
    };
    const error = inspectorFieldErrors(doc, "b")["config.promptTemplate"];
    expect(error).toContain("{{output:ghost}}");
    expect(error).toContain("upstream: a");
    expect(error).not.toContain("{{output:a}}");
  });

  it("accepts upstream references and clean configs without errors", () => {
    const doc: CanvasDocument = {
      nodes: [
        node("a", { isEntry: true }),
        node("b", {
          promptTemplate: "use {{output:a}} and {{task}}",
          model: "acme/agent-1",
          position: { x: 300, y: 0 },
        }),
      ],
      edges: [edge("a", "b")],
    };
    expect(inspectorFieldErrors(doc, "b")).toEqual({});
  });

  it("returns no errors for exit nodes and unknown ids", () => {
    const doc: CanvasDocument = {
      nodes: [node("a", { isEntry: true }), exit("x")],
      edges: [edge("a", "x")],
    };
    expect(inspectorFieldErrors(doc, "x")).toEqual({});
    expect(inspectorFieldErrors(doc, "ghost")).toEqual({});
  });
});

describe("inspectorReducer (doc round-trip)", () => {
  const base = (): CanvasDocument => ({
    nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } })],
    edges: [edge("a", "b")],
  });

  it("configures a node fully and round-trips it through fromCanvasDocument", () => {
    let doc = base();
    doc = inspectorReducer(doc, { type: "patchName", nodeId: "b", name: "Review" });
    doc = inspectorReducer(doc, {
      type: "patchConfig",
      nodeId: "b",
      patch: {
        driver: "claude",
        model: "anthropic/claude-sonnet-4",
        mode: "ask",
        continueSession: true,
        promptTemplate: "Review {{task}} (pass {{iterations}}) against {{output:a}}",
      },
    });

    const graph = fromCanvasDocument(doc);
    const reviewed = graph.nodes.find((candidate) => candidate.id === "b");
    expect(reviewed).toMatchObject({
      name: "Review",
      config: {
        driver: "claude",
        model: "anthropic/claude-sonnet-4",
        mode: "ask",
        continueSession: true,
        promptTemplate: "Review {{task}} (pass {{iterations}}) against {{output:a}}",
      },
    });
  });

  it("inserts a variable into the prompt at the given caret", () => {
    let doc = base();
    doc = inspectorReducer(doc, {
      type: "patchConfig",
      nodeId: "b",
      patch: { promptTemplate: "Do the thing" },
    });
    doc = inspectorReducer(doc, {
      type: "insertVariable",
      nodeId: "b",
      token: "{{output:a}} ",
      at: 3,
    });
    const target = doc.nodes.find((candidate) => candidate.id === "b");
    expect(target?.data.kind === "agent" && target.data.config.promptTemplate).toBe(
      "Do {{output:a}} the thing",
    );
  });

  it("strips explicit-undefined patch keys (model cleared stays absent)", () => {
    let doc = base();
    doc = inspectorReducer(doc, {
      type: "patchConfig",
      nodeId: "b",
      patch: { model: "acme/agent-1" },
    });
    doc = inspectorReducer(doc, {
      type: "patchConfig",
      nodeId: "b",
      patch: { model: undefined },
    });
    const target = doc.nodes.find((candidate) => candidate.id === "b");
    if (target?.data.kind !== "agent") throw new Error("expected an agent node");
    expect("model" in target.data.config).toBe(false);
  });

  it("ignores edits to unknown nodes", () => {
    const doc = base();
    expect(applyInspectorAction(doc, { type: "patchName", nodeId: "ghost", name: "x" })).toBe(doc);
  });
});

describe("dirty tracking integration", () => {
  const base = (): CanvasDocument => ({
    nodes: [node("a", { isEntry: true }), node("b", { position: { x: 300, y: 0 } })],
    edges: [edge("a", "b")],
  });

  it("a config edit flips the projection dirty; saving flips it back", () => {
    const saved = base();
    const edited = inspectorReducer(saved, {
      type: "patchConfig",
      nodeId: "b",
      patch: { model: "acme/agent-x" },
    });
    // dirty = !canvasDocsEquivalent(doc, savedDoc)
    expect(canvasDocsEquivalent(saved, edited)).toBe(false);
    // A name edit is equally dirty.
    const renamed = inspectorReducer(edited, {
      type: "patchName",
      nodeId: "b",
      name: "Reviewer",
    });
    expect(canvasDocsEquivalent(saved, renamed)).toBe(false);
    // Save: the (normalized) saved document becomes the new baseline.
    expect(canvasDocsEquivalent(renamed, renamed)).toBe(true);
    expect(canvasDocsEquivalent(edited, renamed)).toBe(false);
  });

  it("runtime-only selection flags never read as dirty", () => {
    const saved = base();
    const touched = {
      ...saved,
      nodes: saved.nodes.map((candidate) =>
        candidate.id === "b" ? { ...candidate, selected: true } : candidate,
      ),
    };
    expect(canvasDocsEquivalent(saved, touched)).toBe(true);
  });
});
