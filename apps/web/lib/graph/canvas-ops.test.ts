import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@openeuler/core";
import { WorkflowGraphSchema } from "@openeuler/core";
import {
  createAgentNode,
  createExitNode,
  DEFAULT_AGENT_PROMPT_TEMPLATE,
  toCanvasDocument,
  type CanvasDocument,
  type CanvasNode,
} from "./canvas-document";
import {
  applyConnect,
  applyDelete,
  checkConnect,
  planDelete,
  selectionHasDeletables,
  AUTO_CONVERTED_CONDITION,
} from "./canvas-ops";
import { commit, commitWithBefore, initHistory, redo, replacePresent, undo } from "./history";
import { validateCanvasDocument } from "./validation";

function node(
  id: string,
  position: { x: number; y: number },
  options: { name?: string; isEntry?: boolean } = {},
): CanvasNode {
  const base = options.isEntry
    ? createAgentNode({ id, name: options.name ?? id, isEntry: true })
    : createAgentNode({ id, name: options.name ?? id });
  return { ...base, position };
}

function exitNode(id: string, position: { x: number; y: number }): CanvasNode {
  return { ...createExitNode(position), id, data: { kind: "exit", name: "Exit" } };
}

/** entry → review → exit, all `always` edges. */
function chainDoc(): CanvasDocument {
  return {
    nodes: [
      node("entry", { x: 0, y: 0 }, { isEntry: true, name: "implement" }),
      node("review", { x: 300, y: 0 }),
      exitNode("exit", { x: 600, y: 0 }),
    ],
    edges: [
      {
        id: "e-entry-review",
        source: "entry",
        target: "review",
        data: { condition: { type: "always" } },
      },
      {
        id: "e-review-exit",
        source: "review",
        target: "exit",
        data: { condition: { type: "always" } },
      },
    ],
  };
}

/** entry + review, unconnected (for first-edge connects). */
function unconnectedDoc(): CanvasDocument {
  return {
    nodes: [node("entry", { x: 0, y: 0 }, { isEntry: true }), node("review", { x: 300, y: 0 })],
    edges: [],
  };
}

describe("checkConnect / applyConnect", () => {
  it("rejects connections into the entry node", () => {
    const check = checkConnect(chainDoc(), { source: "review", target: "entry" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("entry-target");
  });

  it("rejects duplicate edges", () => {
    const check = checkConnect(chainDoc(), { source: "entry", target: "review" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("duplicate");
  });

  it("rejects edges out of an exit node", () => {
    const check = checkConnect(chainDoc(), { source: "exit", target: "review" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("exit-source");
  });

  it("creates the first outgoing edge as always", () => {
    const check = checkConnect(unconnectedDoc(), { source: "entry", target: "review" });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.edge.data.condition).toEqual({ type: "always" });
    expect(check.convertedEdgeId).toBeUndefined();
    expect(
      checkConnect(applyConnect(unconnectedDoc(), check), { source: "entry", target: "review" }).ok,
    ).toBe(false);
  });

  it("keeps the existing always fallback; the NEW second edge is the conditional", () => {
    const doc = chainDoc();
    const withFix: CanvasDocument = {
      nodes: [...doc.nodes, node("fix", { x: 600, y: 200 })],
      edges: doc.edges,
    };
    const check = checkConnect(withFix, { source: "review", target: "fix" });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.convertedEdgeId).toBe("e-review-fix");

    const next = applyConnect(withFix, check);
    const fallback = next.edges.find((edge) => edge.id === "e-review-exit");
    expect(fallback?.data.condition).toEqual({ type: "always" });
    const added = next.edges.find((edge) => edge.target === "fix");
    expect(added?.data.condition).toEqual(AUTO_CONVERTED_CONDITION);
    // The placeholder's empty pattern is invalid — saving stays blocked
    // until the user fills the condition in.
    expect(validateCanvasDocument(next).some((issue) => issue.edgeId === "e-review-fix")).toBe(
      true,
    );
  });

  it("a third connect adds another conditional without churning existing edges", () => {
    const doc = chainDoc();
    const withTargets: CanvasDocument = {
      nodes: [...doc.nodes, node("fix", { x: 600, y: 200 }), node("test", { x: 600, y: 400 })],
      edges: doc.edges,
    };
    const second = checkConnect(withTargets, { source: "review", target: "fix" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const afterSecond = applyConnect(withTargets, second);
    // The user filled the second edge's condition in.
    const filled: CanvasDocument = {
      ...afterSecond,
      edges: afterSecond.edges.map((edge) =>
        edge.id === "e-review-fix"
          ? {
              ...edge,
              data: { ...edge.data, condition: { type: "outputContains", pattern: "tests" } },
            }
          : edge,
      ),
    };

    const third = checkConnect(filled, { source: "review", target: "test" });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.convertedEdgeId).toBe("e-review-test");
    const after = applyConnect(filled, third);

    expect(after.edges.find((edge) => edge.id === "e-review-exit")?.data.condition).toEqual({
      type: "always",
    });
    expect(after.edges.find((edge) => edge.id === "e-review-fix")?.data.condition).toEqual({
      type: "outputContains",
      pattern: "tests",
    });
    expect(after.edges.find((edge) => edge.id === "e-review-test")?.data.condition).toEqual(
      AUTO_CONVERTED_CONDITION,
    );
  });
});

describe("planDelete / applyDelete", () => {
  it("keeps the pinned entry node", () => {
    const plan = planDelete(chainDoc(), { nodeIds: ["entry", "review"], edgeIds: [] });
    expect(plan.nodes).toEqual(["review"]);
  });

  it("removes dangling edges with their nodes", () => {
    const next = applyDelete(
      chainDoc(),
      planDelete(chainDoc(), { nodeIds: ["review"], edgeIds: [] }),
    );
    expect(next.nodes.map((candidate) => candidate.id)).toEqual(["entry", "exit"]);
    expect(next.edges).toEqual([]);
  });

  it("deletes only the chosen edge", () => {
    const next = applyDelete(
      chainDoc(),
      planDelete(chainDoc(), { nodeIds: [], edgeIds: ["e-entry-review"] }),
    );
    expect(next.edges.map((edge) => edge.id)).toEqual(["e-review-exit"]);
    expect(next.nodes).toHaveLength(3);
  });

  it("selectionHasDeletables is false for the entry alone", () => {
    const doc = chainDoc();
    expect(selectionHasDeletables(doc, { nodeIds: ["entry"], edgeIds: [] })).toBe(false);
    expect(selectionHasDeletables(doc, { nodeIds: ["review"], edgeIds: [] })).toBe(true);
    expect(selectionHasDeletables(doc, { nodeIds: [], edgeIds: ["e-entry-review"] })).toBe(true);
    expect(selectionHasDeletables(doc, { nodeIds: [], edgeIds: [] })).toBe(false);
  });
});

describe("history (undo/redo)", () => {
  it("undo of a connect removes the edge; redo restores it", () => {
    const base = unconnectedDoc();
    let history = initHistory(base);

    const check = checkConnect(base, { source: "entry", target: "review" });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    history = commit(history, applyConnect(base, check));
    expect(history.present.edges).toHaveLength(1);

    const undone = undo(history);
    expect(undone.value?.edges).toEqual([]);
    expect(undone.value?.nodes).toHaveLength(2);

    const redone = redo(undone.history);
    expect(redone.value?.edges.map((edge) => edge.id)).toEqual(["e-entry-review"]);
  });

  it("undo of an add removes the node; undo of a delete restores it", () => {
    const base = chainDoc();
    let history = initHistory(base);

    const withNode: CanvasDocument = {
      nodes: [...base.nodes, node("fix", { x: 600, y: 200 })],
      edges: base.edges,
    };
    history = commit(history, withNode);
    expect(history.present.nodes).toHaveLength(4);
    expect(undo(history).value?.nodes).toHaveLength(3);

    const deleted = applyDelete(
      withNode,
      planDelete(withNode, { nodeIds: ["review"], edgeIds: [] }),
    );
    history = commit(history, deleted);
    const restored = undo(history);
    expect(restored.value?.nodes.map((candidate) => candidate.id)).toContain("review");
    expect(restored.value?.edges).toHaveLength(2);
  });

  it("undo of a move restores the prior position (one entry per drag)", () => {
    const base = chainDoc();
    let history = initHistory(base);

    const moved: CanvasDocument = {
      nodes: base.nodes.map((candidate) =>
        candidate.id === "review" ? { ...candidate, position: { x: 999, y: 999 } } : candidate,
      ),
      edges: base.edges,
    };
    // Drag semantics: intermediate states skip history, one entry is recorded.
    history = replacePresent(history, moved);
    history = commitWithBefore(history, base, history.present);

    expect(history.present.nodes.find((candidate) => candidate.id === "review")?.position).toEqual({
      x: 999,
      y: 999,
    });
    const undone = undo(history);
    expect(undone.value?.nodes.find((candidate) => candidate.id === "review")?.position).toEqual({
      x: 300,
      y: 0,
    });
    expect(undone.history.past).toHaveLength(0);
  });

  it("a new edit clears the redo stack (no state corruption)", () => {
    const base = chainDoc();
    let history = initHistory(base);
    history = commit(history, { ...base, edges: base.edges.slice(0, 1) });
    history = undo(history).history;
    expect(redo(history).value).not.toBeNull();

    const afterUndo = history.present;
    history = commit(history, {
      ...afterUndo,
      edges: [
        ...afterUndo.edges,
        {
          id: "e-review-exit",
          source: "review",
          target: "exit",
          data: { condition: { type: "always" } },
        },
      ],
    });
    expect(redo(history).value).toBeNull();
    expect(undo(history).value?.edges).toHaveLength(2);
  });

  it("sequential undos walk back through every entry, then stop", () => {
    const base = unconnectedDoc();
    let history = initHistory(base);
    history = commit(history, {
      ...base,
      nodes: [...base.nodes, exitNode("exit", { x: 600, y: 0 })],
    });
    history = commit(
      history,
      applyConnect(history.present, {
        ok: true,
        edge: {
          id: "e-entry-review",
          source: "entry",
          target: "review",
          data: { condition: { type: "always" } },
        },
      }),
    );

    const undo1 = undo(history);
    expect(undo1.value?.edges).toEqual([]);
    expect(undo1.value?.nodes).toHaveLength(3);
    const undo2 = undo(undo1.history);
    expect(undo2.value?.nodes).toHaveLength(2);
    const undo3 = undo(undo2.history);
    expect(undo3.value).toBeNull();
    expect(undo3.history).toBe(undo2.history);
  });

  it("debounced edit bursts collapse via commitWithBefore", () => {
    const base = chainDoc();
    let history = initHistory(base);

    // Three keystrokes: each replacePresent silently, one commit at the end.
    for (const prompt of ["a", "ab", "abc"]) {
      const next: CanvasDocument = {
        nodes: history.present.nodes.map((candidate) =>
          candidate.id === "review"
            ? {
                ...candidate,
                data:
                  candidate.data.kind === "agent"
                    ? {
                        ...candidate.data,
                        config: { ...candidate.data.config, promptTemplate: prompt },
                      }
                    : candidate.data,
              }
            : candidate,
        ),
        edges: history.present.edges,
      };
      history = replacePresent(history, next);
    }
    history = commitWithBefore(history, base, history.present);
    expect(history.past).toHaveLength(1);
    const undone = undo(history);
    const restoredReview = undone.value?.nodes.find((candidate) => candidate.id === "review");
    expect(restoredReview?.data.kind === "agent" && restoredReview.data.config.promptTemplate).toBe(
      DEFAULT_AGENT_PROMPT_TEMPLATE,
    );
  });

  it("undo inside the debounce window flushes the pending edit first (redo intact)", () => {
    const withPrompt = (doc: CanvasDocument, prompt: string): CanvasDocument => ({
      ...doc,
      nodes: doc.nodes.map((candidate) =>
        candidate.id === "review" && candidate.data.kind === "agent"
          ? {
              ...candidate,
              data: {
                ...candidate.data,
                config: { ...candidate.data.config, promptTemplate: prompt },
              },
            }
          : candidate,
      ),
    });
    const promptOf = (doc: CanvasDocument): string => {
      const found = doc.nodes.find((candidate) => candidate.id === "review");
      return found !== undefined && found.data.kind === "agent"
        ? found.data.config.promptTemplate
        : "";
    };

    const base = chainDoc();
    let history = initHistory(base);
    // One committed edit before the typing, so a stale flush would corrupt it.
    history = commit(history, {
      ...base,
      nodes: base.nodes.map((candidate) =>
        candidate.id === "entry" ? { ...candidate, position: { x: 40, y: 0 } } : candidate,
      ),
    });

    // Keystrokes land: present moves silently, the before-snapshot is held,
    // the commit timer is pending.
    const beforeTyping = history.present;
    history = replacePresent(history, withPrompt(history.present, "abc"));
    // Undo arrives inside the window: the editor flushes (commits the pending
    // edit) BEFORE stepping — exactly one entry, no post-hoc timer fire.
    history = commitWithBefore(history, beforeTyping, history.present);

    const undone = undo(history);
    expect(undone.value && promptOf(undone.value)).toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
    const redone = redo(undone.history);
    expect(redone.value && promptOf(redone.value)).toBe("abc");
    // A second undo still reaches the earlier committed edit.
    const undoneAgain = undo(undone.history);
    expect(
      undoneAgain.value?.nodes.find((candidate) => candidate.id === "entry")?.position,
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("canvas ops stay schema-serializable", () => {
  it("a graph built via connect ops validates", () => {
    let doc = unconnectedDoc();
    const connect = checkConnect(doc, { source: "entry", target: "review" });
    if (!connect.ok) throw new Error("expected connect to succeed");
    doc = applyConnect(doc, connect);
    doc = applyDelete(doc, planDelete(doc, { nodeIds: [], edgeIds: [] }));

    const graph: WorkflowGraph = WorkflowGraphSchema.parse({
      entryNodeId: "entry",
      nodes: doc.nodes.map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        name: candidate.data.name,
        position: candidate.position,
        ...(candidate.data.kind === "agent"
          ? { config: { ...candidate.data.config, promptTemplate: "work on {{task}}" } }
          : {}),
      })),
      edges: doc.edges.map(({ data, ...rest }) => ({ ...rest, ...data })),
    });
    expect(graph.edges[0]?.condition).toEqual({ type: "always" });
    expect(toCanvasDocument(graph).nodes).toHaveLength(2);
  });
});
