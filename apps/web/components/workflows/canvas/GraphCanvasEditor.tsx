"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { StepConfig } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import {
  canvasDocsEquivalent,
  createAgentNode,
  createExitNode,
  fromCanvasDocument,
  nextCanvasPosition,
  toCanvasDocument,
  uniqueNodeName,
  workflowToCanvasDocument,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasEdgeData,
  type CanvasNode,
} from "@/lib/graph/canvas-document";
import {
  applyConnect,
  applyDelete,
  checkConnect,
  isUnconditionalEdge,
  planDelete,
  selectionHasDeletables,
} from "@/lib/graph/canvas-ops";
import {
  canRedo,
  canUndo,
  commit,
  commitWithBefore,
  initHistory,
  redo,
  replacePresent,
  undo,
  type History,
} from "@/lib/graph/history";
import { applyLayout } from "@/lib/graph/layout";
import { applyInspectorAction } from "@/lib/graph/inspector";
import {
  applyEdgeInspectorAction,
  conditionSummary,
  needsConditionConfig,
  routerFallbackWarnings,
} from "@/lib/graph/edge-inspector";
import {
  issuesFromApiDetails,
  validateCanvasDocument,
  type CanvasIssue,
} from "@/lib/graph/validation";
import { saveWorkflowGraph, type WorkflowWithGraph } from "@/lib/workflows-api";
import {
  canvasNodeTypes,
  NodeIssueCountsContext,
  NodeWarningCountsContext,
  toFlowNodes,
  type CanvasFlowNode,
} from "./canvas-nodes";
import { EdgePropertiesDrawer } from "./EdgePropertiesDrawer";
import { NodePropertiesDrawer } from "./NodePropertiesDrawer";
import { Palette, type PaletteNodeKind, type PaletteSection, CANVAS_NODE_MIME } from "./Palette";
import { ShortcutsPopover } from "./ShortcutsPopover";
import { ValidationPanel } from "./ValidationPanel";

/** Debounce window that collapses a burst of inspector edits into one undo entry. */
const EDIT_COMMIT_DEBOUNCE_MS = 500;
/** How long node position transitions animate after auto-layout. */
const LAYOUT_ANIMATION_MS = 320;

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Whether any node's position differs between two documents (a real drag). */
function positionsChanged(before: CanvasDocument, after: CanvasDocument): boolean {
  return after.nodes.some((node) => {
    const prior = before.nodes.find((candidate) => candidate.id === node.id);
    return (
      prior !== undefined &&
      (prior.position.x !== node.position.x || prior.position.y !== node.position.y)
    );
  });
}

/**
 * Document → React Flow edges. Condition summaries label every router and
 * conditional edge (#48): conditional edges dashed in info blue, the
 * `always` fallback of a router subtle and dotted, unconfigured
 * placeholder conditions in warning amber, validation-flagged edges red.
 * Plain chain edges (a node's single unconditional outgoing edge) stay
 * unlabeled to keep linear graphs quiet.
 */
function toFlowEdges(doc: CanvasDocument, issues: readonly CanvasIssue[]): Edge<CanvasEdgeData>[] {
  const problematic = new Set(
    issues.filter((issue) => issue.edgeId !== undefined).map((issue) => issue.edgeId),
  );
  const outgoing = new Map<string, number>();
  for (const edge of doc.edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }
  return doc.edges.map((edge): Edge<CanvasEdgeData> => {
    const conditional = !isUnconditionalEdge(edge.data);
    const invalid = problematic.has(edge.id);
    const unconfigured = needsConditionConfig(edge.data);
    const router = (outgoing.get(edge.source) ?? 0) > 1;

    let stroke = "var(--muted-fg)";
    let strokeWidth = 2;
    let dash: { strokeDasharray: string } | Record<string, never> = {};
    if (conditional) {
      stroke = "var(--info)";
      dash = { strokeDasharray: "6 4" };
      if (unconfigured) {
        stroke = "var(--warning)";
        strokeWidth = 2.5;
      }
    } else if (router) {
      strokeWidth = 1.5;
      dash = { strokeDasharray: "2 5" };
    }
    if (invalid) {
      stroke = "var(--danger)";
      strokeWidth = 2.5;
    }

    return {
      ...edge,
      label: conditional || router ? conditionSummary(edge.data) : undefined,
      labelBgStyle: { fill: "var(--surface)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      labelStyle: {
        fill: invalid ? "var(--danger)" : unconfigured ? "var(--warning)" : stroke,
        fontSize: "10px",
      },
      style: { stroke, strokeWidth, ...dash },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
    };
  });
}

/**
 * The graph canvas editor (#46): React Flow canvas + palette + inspector +
 * validation UX, serialized 1:1 to `WorkflowGraph` on save (PUT …/graph →
 * new revision). Undo/redo over an immutable-document history; drags and
 * inspector edits collapse into single entries.
 */
export function GraphCanvasEditor({
  workflow,
  drivers,
}: {
  workflow: WorkflowWithGraph;
  drivers: readonly string[];
}) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner workflow={workflow} drivers={drivers} />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner({
  workflow,
  drivers,
}: {
  workflow: WorkflowWithGraph;
  drivers: readonly string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { screenToFlowPosition, fitView } = useReactFlow();

  const initialDoc = useMemo(() => workflowToCanvasDocument(workflow), [workflow]);

  const [history, setHistory] = useState<History<CanvasDocument>>(() => initHistory(initialDoc));
  const historyRef = useRef(history);
  const updateHistory = useCallback(
    (updater: (current: History<CanvasDocument>) => History<CanvasDocument>) => {
      historyRef.current = updater(historyRef.current);
      setHistory(historyRef.current);
    },
    [],
  );

  const doc = history.present;
  const [savedDoc, setSavedDoc] = useState<CanvasDocument>(initialDoc);
  const [issues, setIssues] = useState<CanvasIssue[]>([]);
  const [revision, setRevision] = useState(workflow.latestRevision?.number);
  const [saving, setSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [layoutAnimating, setLayoutAnimating] = useState(false);

  // Node-drag + debounced-edit undo capture.
  const dragBeforeRef = useRef<CanvasDocument | null>(null);
  const editBeforeRef = useRef<CanvasDocument | null>(null);
  const editTimerRef = useRef<number | null>(null);

  // Dirty via the serialized projections: React Flow runtime keys (`selected`,
  // `measured`, `dragging`, …) must never read as unsaved changes.
  const dirty = useMemo(() => !canvasDocsEquivalent(doc, savedDoc), [doc, savedDoc]);

  // Live-refresh the validation overlay while issues are shown, so badges
  // clear as the user fixes things.
  useEffect(() => {
    if (issues.length === 0) return;
    setIssues(validateCanvasDocument(historyRef.current.present));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const clearEditTimer = useCallback(() => {
    if (editTimerRef.current !== null) {
      window.clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearEditTimer, [clearEditTimer]);

  /** Snapshot commit (add/connect/delete/layout). */
  const commitDoc = useCallback(
    (next: CanvasDocument) => {
      clearEditTimer();
      editBeforeRef.current = null;
      updateHistory((current) => commit(current, next));
    },
    [clearEditTimer, updateHistory],
  );

  /**
   * Ends a pending debounced edit now: cancels the timer and commits the
   * captured before-snapshot as a history entry. Undo/redo/save landing
   * inside the window call this first so they step over a settled history —
   * no stale snapshots, no post-hoc entries, redo preserved.
   */
  const flushPendingEdit = useCallback(() => {
    clearEditTimer();
    const before = editBeforeRef.current;
    editBeforeRef.current = null;
    if (before === null) return;
    updateHistory((current) => commitWithBefore(current, before, current.present));
  }, [clearEditTimer, updateHistory]);

  /** Debounced commit for drawer/edge-panel edits. */
  const patchDocDebounced = useCallback(
    (updater: (current: CanvasDocument) => CanvasDocument) => {
      if (editBeforeRef.current === null) editBeforeRef.current = historyRef.current.present;
      updateHistory((current) => replacePresent(current, updater(current.present)));
      clearEditTimer();
      editTimerRef.current = window.setTimeout(() => {
        editTimerRef.current = null;
        const before = editBeforeRef.current;
        editBeforeRef.current = null;
        if (before === null) return;
        updateHistory((current) => commitWithBefore(current, before, current.present));
      }, EDIT_COMMIT_DEBOUNCE_MS);
    },
    [clearEditTimer, updateHistory],
  );

  // Settle a pending debounced inspector edit whenever the inspected target
  // changes (drawer close, deselect, switching nodes or edges) so the edit
  // session lands as one undo entry instead of lingering mid-burst.
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  useEffect(() => {
    if (selectedNodeIdRef.current === selectedNodeId) return;
    selectedNodeIdRef.current = selectedNodeId;
    flushPendingEdit();
  }, [selectedNodeId, flushPendingEdit]);

  const selectedEdgeIdRef = useRef<string | null>(selectedEdgeId);
  useEffect(() => {
    if (selectedEdgeIdRef.current === selectedEdgeId) return;
    selectedEdgeIdRef.current = selectedEdgeId;
    flushPendingEdit();
  }, [selectedEdgeId, flushPendingEdit]);

  const pruneSelection = useCallback(
    (next: CanvasDocument) => {
      if (selectedNodeId !== null && !next.nodes.some((node) => node.id === selectedNodeId)) {
        setSelectedNodeId(null);
      }
      if (selectedEdgeId !== null && !next.edges.some((edge) => edge.id === selectedEdgeId)) {
        setSelectedEdgeId(null);
      }
    },
    [selectedNodeId, selectedEdgeId],
  );

  const doUndo = useCallback(() => {
    flushPendingEdit();
    const step = undo(historyRef.current);
    if (step.value === null) return;
    updateHistory(() => step.history);
    pruneSelection(step.value);
  }, [flushPendingEdit, pruneSelection, updateHistory]);

  const doRedo = useCallback(() => {
    flushPendingEdit();
    const step = redo(historyRef.current);
    if (step.value === null) return;
    updateHistory(() => step.history);
    pruneSelection(step.value);
  }, [flushPendingEdit, pruneSelection, updateHistory]);

  const save = useCallback(async () => {
    if (saving) return;
    flushPendingEdit();
    const clientIssues = validateCanvasDocument(historyRef.current.present);
    setIssues(clientIssues);
    if (clientIssues.length > 0) {
      toast({
        variant: "danger",
        title: "Cannot save yet",
        description: `${clientIssues.length} issue${clientIssues.length === 1 ? "" : "s"} must be fixed — see the validation panel.`,
      });
      return;
    }
    setSaving(true);
    try {
      const result = await saveWorkflowGraph({
        workflowId: workflow.id,
        graph: fromCanvasDocument(historyRef.current.present),
      });
      const normalized =
        result.workflow.graph !== undefined
          ? toCanvasDocument(result.workflow.graph)
          : historyRef.current.present;
      setSavedDoc(normalized);
      updateHistory((current) => replacePresent(current, normalized));
      setRevision(result.revision.number);
      setIssues([]);
      toast({ variant: "success", title: `Saved revision ${result.revision.number}` });
    } catch (cause) {
      if (cause instanceof ApiError && cause.details !== undefined && cause.details.length > 0) {
        setIssues(issuesFromApiDetails(historyRef.current.present, cause.details));
        toast({
          variant: "danger",
          title: "The daemon rejected the graph",
          description: "See the flagged nodes and edges.",
        });
      } else {
        toast({
          variant: "danger",
          title: "Failed to save",
          description: cause instanceof ApiError ? cause.message : "Unexpected error",
        });
      }
    } finally {
      setSaving(false);
    }
  }, [flushPendingEdit, saving, toast, updateHistory, workflow.id]);

  const addNode = useCallback(
    (kind: PaletteNodeKind, position?: { x: number; y: number }) => {
      const current = historyRef.current.present;
      const spot = position ?? nextCanvasPosition(current);
      const node: CanvasNode =
        kind === "agent"
          ? createAgentNode({
              position: spot,
              driver: drivers[0] ?? "opencode",
              name: uniqueNodeName(
                "Agent",
                new Set(current.nodes.map((existing) => existing.data.name)),
              ),
            })
          : createExitNode(spot);
      commitDoc({ nodes: [...current.nodes, node], edges: current.edges });
      setSelectedEdgeId(null);
      setSelectedNodeId(node.id);
    },
    [commitDoc, drivers],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === null || connection.target === null) return;
      const current = historyRef.current.present;
      const check = checkConnect(current, {
        source: connection.source,
        target: connection.target,
      });
      if (!check.ok) {
        toast({ variant: "danger", title: "Connection rejected", description: check.message });
        return;
      }
      commitDoc(applyConnect(current, check));
      if (check.convertedEdgeId !== undefined) {
        toast({
          variant: "info",
          title: "Edge added as conditional",
          description:
            "A node can keep only one always edge (its router fallback) — the new edge needs a condition before the graph can be saved.",
        });
      }
    },
    [commitDoc, toast],
  );

  const deleteSelection = useCallback(() => {
    const current = historyRef.current.present;
    const selection = {
      nodeIds: current.nodes.filter((node) => node.selected === true).map((node) => node.id),
      edgeIds: current.edges.filter((edge) => edge.selected === true).map((edge) => edge.id),
    };
    if (!selectionHasDeletables(current, selection)) return;
    commitDoc(applyDelete(current, planDelete(current, selection)));
  }, [commitDoc]);

  const onAutoLayout = useCallback(() => {
    const next = applyLayout(historyRef.current.present);
    setLayoutAnimating(true);
    commitDoc(next);
    window.setTimeout(() => setLayoutAnimating(false), LAYOUT_ANIMATION_MS);
    window.setTimeout(() => void fitView({ padding: 0.15, duration: LAYOUT_ANIMATION_MS }), 20);
  }, [commitDoc, fitView]);

  const patchNodeConfig = useCallback(
    (nodeId: string, patch: Partial<StepConfig>) => {
      patchDocDebounced((current) =>
        applyInspectorAction(current, { type: "patchConfig", nodeId, patch }),
      );
    },
    [patchDocDebounced],
  );

  const patchNodeName = useCallback(
    (nodeId: string, name: string) => {
      patchDocDebounced((current) =>
        applyInspectorAction(current, { type: "patchName", nodeId, name }),
      );
    },
    [patchDocDebounced],
  );

  const patchEdge = useCallback(
    (edgeId: string, patch: Partial<CanvasEdge["data"]>) => {
      patchDocDebounced((current) =>
        applyEdgeInspectorAction(current, { type: "patchEdge", edgeId, patch }),
      );
    },
    [patchDocDebounced],
  );

  /** Reordering is a discrete action: one snapshot per click. */
  const moveEdgeOrder = useCallback(
    (edgeId: string, direction: -1 | 1) => {
      commitDoc(
        applyEdgeInspectorAction(historyRef.current.present, {
          type: "moveEdge",
          edgeId,
          direction,
        }),
      );
    },
    [commitDoc],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      const current = historyRef.current.present;
      const next = applyDelete(current, planDelete(current, { nodeIds: [nodeId], edgeIds: [] }));
      commitDoc(next);
      setSelectedNodeId(null);
    },
    [commitDoc],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      const current = historyRef.current.present;
      commitDoc(applyDelete(current, planDelete(current, { nodeIds: [], edgeIds: [edgeId] })));
      setSelectedEdgeId(null);
    },
    [commitDoc],
  );

  // Keyboard: cmd+s save, cmd+z/shift+cmd+z undo/redo, delete selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !isTypingTarget(event.target)) {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection, doRedo, doUndo, save]);

  // Dirty-state guard: browser-level.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      // Position/selection only: removals run through the editor's own
      // history-committed delete path, and dimension measurements stay in
      // React Flow's runtime layer (never serialized into the document).
      const structural = changes.filter(
        (change): change is NodeChange<CanvasNode> =>
          change.type === "position" || change.type === "select",
      ) as unknown as NodeChange<CanvasNode>[];
      updateHistory((current) => ({
        ...current,
        present: {
          ...current.present,
          nodes: applyNodeChanges(structural, current.present.nodes),
        },
      }));
    },
    [updateHistory],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge<CanvasEdgeData>>[]) => {
      const structural = changes.filter(
        (change) => change.type === "select",
      ) as unknown as EdgeChange<Edge<CanvasEdgeData>>[];
      updateHistory((current) => ({
        ...current,
        present: {
          ...current.present,
          edges: applyEdgeChanges(structural, current.present.edges) as CanvasEdge[],
        },
      }));
    },
    [updateHistory],
  );

  const onNodeDragStart = useCallback(() => {
    dragBeforeRef.current = historyRef.current.present;
  }, []);

  const onNodeDragStop = useCallback(() => {
    const before = dragBeforeRef.current;
    dragBeforeRef.current = null;
    if (before === null) return;
    // Click-to-select fires drag start/stop without moving anything —
    // skip the history entry for it.
    if (!positionsChanged(before, historyRef.current.present)) return;
    updateHistory((current) => commitWithBefore(current, before, current.present));
  }, [updateHistory]);

  const nodes = useMemo(() => toFlowNodes(doc.nodes), [doc.nodes]);
  const edges = useMemo(() => toFlowEdges(doc, issues), [doc, issues]);
  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      if (issue.nodeId !== undefined) counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
    }
    return counts;
  }, [issues]);
  // Advisory warnings (router with no `always` fallback) are live, not
  // save-gated — they should appear and clear as the user edits.
  const warnings = useMemo(() => routerFallbackWarnings(doc), [doc]);
  const warningCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const warning of warnings) {
      counts.set(warning.nodeId, (counts.get(warning.nodeId) ?? 0) + 1);
    }
    return counts;
  }, [warnings]);
  const nodeNames = useMemo(
    () => new Map(doc.nodes.map((node) => [node.id, node.data.name])),
    [doc.nodes],
  );

  const selectedNode =
    selectedNodeId === null ? null : (doc.nodes.find((node) => node.id === selectedNodeId) ?? null);
  const selectedEdge =
    selectedEdgeId === null ? null : (doc.edges.find((edge) => edge.id === selectedEdgeId) ?? null);

  const isEmpty = doc.nodes.length <= 1 && doc.edges.length === 0;
  const basePath = `/projects/${encodeURIComponent(workflow.projectId)}/workflows`;

  const paletteSections: PaletteSection[] = [
    {
      id: "steps",
      title: "Steps",
      description: "Drag onto the canvas",
      items: [
        {
          kind: "agent",
          title: "Agent step",
          description: "One agent invocation",
          icon: (
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
              <circle cx="10" cy="8" r="1" fill="currentColor" stroke="none" />
            </svg>
          ),
        },
        {
          kind: "exit",
          title: "Exit node",
          description: "Terminal marker",
          icon: (
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="8" cy="8" r="6" />
              <rect
                x="5.5"
                y="5.5"
                width="5"
                height="5"
                rx="0.5"
                fill="currentColor"
                stroke="none"
              />
            </svg>
          ),
        },
      ],
    },
  ];

  const requestBack = () => {
    if (dirty) setConfirmLeave(true);
    else router.push(basePath);
  };

  const focusIssue = (issue: CanvasIssue) => {
    if (issue.nodeId !== undefined) {
      setSelectedEdgeId(null);
      setSelectedNodeId(issue.nodeId);
      void fitView({ nodes: [{ id: issue.nodeId }], duration: 320, maxZoom: 1.2, padding: 0.2 });
      return;
    }
    if (issue.edgeId !== undefined) {
      const edge = doc.edges.find((candidate) => candidate.id === issue.edgeId);
      if (edge === undefined) return;
      setSelectedNodeId(null);
      setSelectedEdgeId(edge.id);
      void fitView({
        nodes: [{ id: edge.source }, { id: edge.target }],
        duration: 320,
        maxZoom: 1.2,
        padding: 0.2,
      });
    }
  };

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col" data-canvas-editor>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={requestBack}
          className="rounded-md px-2 py-1 text-sm text-muted-fg transition-colors hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          ← Workflows
        </button>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <h1 className="min-w-0 truncate text-sm font-semibold text-fg" title={workflow.name}>
          {workflow.name}
        </h1>
        {revision !== undefined ? <Badge variant="neutral">revision {revision}</Badge> : null}
        {dirty ? <Badge variant="warning">unsaved changes</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={doUndo}
            disabled={!canUndo(history)}
            aria-label="Undo"
            title="Undo (⌘/Ctrl+Z)"
          >
            Undo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={doRedo}
            disabled={!canRedo(history)}
            aria-label="Redo"
            title="Redo (⇧⌘/Ctrl+Z)"
          >
            Redo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onAutoLayout}
            title="Tidy the layout (left to right)"
          >
            Auto-layout
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving} loading={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <ShortcutsPopover />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Palette sections={paletteSections} onAdd={(kind) => addNode(kind)} />

        <div
          className={
            layoutAnimating
              ? "relative min-w-0 flex-1 canvas-layout-animating"
              : "relative min-w-0 flex-1"
          }
          onDrop={(event) => {
            event.preventDefault();
            const kind = event.dataTransfer.getData(CANVAS_NODE_MIME);
            if (kind !== "agent" && kind !== "exit") return;
            const position = screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            addNode(kind, position);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          data-canvas-canvas
        >
          <NodeIssueCountsContext.Provider value={issueCounts}>
            <NodeWarningCountsContext.Provider value={warningCounts}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={canvasNodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeDragStart={onNodeDragStart}
                onNodeDragStop={onNodeDragStop}
                onNodeClick={(_, node) => {
                  setSelectedEdgeId(null);
                  setSelectedNodeId(node.id);
                }}
                onEdgeClick={(_, edge) => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(edge.id);
                }}
                onPaneClick={() => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(null);
                }}
                deleteKeyCode={null}
                multiSelectionKeyCode={["Meta", "Shift"]}
                minZoom={0.2}
                maxZoom={2.5}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                colorMode="dark"
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </NodeWarningCountsContext.Provider>
          </NodeIssueCountsContext.Provider>

          {isEmpty ? (
            <div className="pointer-events-none absolute top-6 left-1/2 z-10 w-80 -translate-x-1/2 rounded-lg border border-border bg-surface p-3 text-center shadow-3">
              <p className="text-sm font-medium text-fg">Start building your graph</p>
              <p className="mt-1 text-xs text-muted-fg">
                Drag an <span className="font-medium text-fg">Agent step</span> from the palette,
                connect it to the pinned entry node, then add branches, loops, and an exit.
              </p>
            </div>
          ) : null}

          <ValidationPanel
            issues={issues}
            warnings={warnings}
            nodeNames={nodeNames}
            onFocusIssue={focusIssue}
            className="absolute bottom-3 left-3 z-10 w-[28rem] max-w-[calc(100%-1.5rem)]"
          />

          {dirty ? (
            <p className="absolute bottom-3 right-14 z-10 text-xs text-muted-fg" role="status">
              Unsaved changes — ⌘/Ctrl+S to save
            </p>
          ) : null}
        </div>
      </div>

      {selectedEdge !== null ? (
        <EdgePropertiesDrawer
          edge={selectedEdge}
          doc={doc}
          issues={issues}
          onPatch={(patch) => patchEdge(selectedEdge.id, patch)}
          onMove={moveEdgeOrder}
          onCommitEdit={flushPendingEdit}
          onDelete={() => deleteEdge(selectedEdge.id)}
          onClose={() => setSelectedEdgeId(null)}
        />
      ) : null}

      {selectedNode !== null ? (
        <NodePropertiesDrawer
          node={selectedNode}
          doc={doc}
          issues={issues}
          onPatchAgent={(patch) => patchNodeConfig(selectedNode.id, patch)}
          onPatchName={(name) => patchNodeName(selectedNode.id, name)}
          onCommitEdit={flushPendingEdit}
          onDelete={() => deleteNode(selectedNode.id)}
          onClose={() => setSelectedNodeId(null)}
        />
      ) : null}

      <Dialog open={confirmLeave} onClose={() => setConfirmLeave(false)} label="Unsaved changes">
        <h2 className="text-title font-semibold text-fg">Leave with unsaved changes?</h2>
        <p className="mt-1 text-sm text-muted-fg">
          Your canvas edits have not been saved as a revision yet. Leaving discards them.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={() => router.push(basePath)}>
            Discard and leave
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
