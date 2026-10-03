import type {
  AgentGraphNode,
  ExitCondition,
  ExitGraphNode,
  GraphEdge,
  GraphNode,
  GraphNodePosition,
  JoinGraphNode,
  StepConfig,
  WorkflowGraph,
  WorkflowGraphShape,
} from "@openeuler/core";
import { linearToGraph } from "@openeuler/core";
import type { Workflow } from "@openeuler/core";

/**
 * Canvas document model for the graph builder (#46): the React Flow
 * nodes/edges in their exact serialized shape. Deliberately free of React
 * and @xyflow/react imports — every node/edge object here is structurally
 * compatible with React Flow's `Node`/`Edge`, so the editor passes them
 * straight through and the mapping to {@link WorkflowGraph} is unit-testable
 * without a browser.
 */

/**
 * Agent node card payload (the graph node minus id/position). The
 * `Record<string, unknown>` base satisfies React Flow's node-data constraint
 * without loosening the fields.
 */
export interface AgentNodeData extends Record<string, unknown> {
  kind: "agent";
  name: string;
  config: StepConfig;
  /** Canvas-only: marks the node `entryNodeId` points at. */
  isEntry: boolean;
  /**
   * Preset the node was created from (#49): provenance for the inspector
   * badge and the explicit "Update from preset" action. The node always
   * keeps its own config copy. Absent for plain/detached nodes; a presetId
   * that no longer resolves is treated as detached client-side.
   */
  presetId?: string;
}

/** Exit terminal marker payload. */
export interface ExitNodeData extends Record<string, unknown> {
  kind: "exit";
  name: string;
}

/** Join/merge synchronizer payload (#115): mode all (default) or any. */
export interface JoinNodeData extends Record<string, unknown> {
  kind: "join";
  name: string;
  config: { mode: "all" | "any" };
}

export type CanvasNodeData = AgentNodeData | ExitNodeData | JoinNodeData;

export type CanvasNode = {
  id: string;
  type: "agent" | "exit" | "join";
  position: GraphNodePosition;
  data: CanvasNodeData;
  /** React Flow selection flag; runtime-only, never serialized. */
  selected?: boolean;
};

/** Edge card payload: everything `GraphEdge` carries besides endpoints. */
export interface CanvasEdgeData extends Record<string, unknown> {
  condition: ExitCondition;
  order?: number;
  maxIterations?: number;
  invert?: boolean;
}

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  data: CanvasEdgeData;
  /** React Flow selection flag; runtime-only, never serialized. */
  selected?: boolean;
};

/** The full editor state: 1:1 with a `WorkflowGraph`. */
export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Deterministic edge id for a source→target pair (duplicates are rejected). */
export function canvasEdgeId(source: string, target: string): string {
  return `e-${source}-${target}`;
}

/** Position for a node auto-placed to the right of the current rightmost node. */
export function nextCanvasPosition(doc: CanvasDocument, nodeWidth = 280): GraphNodePosition {
  let maxX = Number.NEGATIVE_INFINITY;
  for (const node of doc.nodes) maxX = Math.max(maxX, node.position.x);
  if (maxX === Number.NEGATIVE_INFINITY) return { x: 0, y: 0 };
  return { x: maxX + nodeWidth, y: 0 };
}

export function newCanvasNodeId(): string {
  return crypto.randomUUID();
}

export interface CreateAgentNodeOptions {
  id?: string;
  position?: GraphNodePosition;
  name?: string;
  driver?: string;
  isEntry?: boolean;
}

/**
 * Default prompt for palette-dropped agent nodes (#68): mirrors the starter
 * graph's implementer prompt so a dropped node is one connection away from
 * valid. Users edit it freely in the inspector.
 */
export const DEFAULT_AGENT_PROMPT_TEMPLATE = "Work on the following task:\n\n{{task}}";

/**
 * A fresh agent node as the palette creates it: default driver, `auto` mode,
 * and the `{{task}}`-based default prompt (an empty prompt only appears if
 * the user deliberately clears it — which then validates live).
 */
export function createAgentNode(options: CreateAgentNodeOptions = {}): CanvasNode {
  return {
    id: options.id ?? newCanvasNodeId(),
    type: "agent",
    position: options.position ?? { x: 0, y: 0 },
    data: {
      kind: "agent",
      name: options.name ?? "Agent",
      isEntry: options.isEntry ?? false,
      config: {
        driver: options.driver ?? "opencode",
        mode: "auto",
        promptTemplate: DEFAULT_AGENT_PROMPT_TEMPLATE,
        continueSession: false,
      },
    },
  };
}

export function createExitNode(
  position: GraphNodePosition = { x: 0, y: 0 },
  name = "Exit",
): CanvasNode {
  return {
    id: newCanvasNodeId(),
    type: "exit",
    position,
    data: { kind: "exit", name },
  };
}

/**
 * A fresh join node as the palette creates it (#116): mode `all` by default —
 * the synchronizer waits for every branch. The inspector's mode toggle
 * switches it to `any` (first winner, losers cancelled).
 */
export function createJoinNode(
  position: GraphNodePosition = { x: 0, y: 0 },
  name = "Join",
  mode: "all" | "any" = "all",
): CanvasNode {
  return {
    id: newCanvasNodeId(),
    type: "join",
    position,
    data: { kind: "join", name, config: { mode } },
  };
}

/** Structural slice of an {@link AgentPreset} the canvas needs to build a node. */
export type PresetSource = {
  id: string;
  name: string;
  config: StepConfig;
};

export interface CreatePresetAgentNodeOptions {
  preset: PresetSource;
  position?: GraphNodePosition;
  /** Taken node names, so the preset name gets a unique suffix on clashes. */
  takenNames?: ReadonlySet<string>;
}

/**
 * A fresh agent node preconfigured from a preset (#49): name = the preset's
 * name (uniquified against `takenNames`), config a deep copy of the preset's
 * config, and `presetId` carried for the inspector badge. Later preset edits
 * never reach this node unless the user clicks "Update from preset". A
 * preset whose config carries an empty prompt falls back to the default
 * `{{task}}` template, so every drop path lands a runnable prompt (#68).
 */
export function createPresetAgentNode(options: CreatePresetAgentNodeOptions): CanvasNode {
  const { preset } = options;
  const config = structuredClone(preset.config);
  if (config.promptTemplate.length === 0) config.promptTemplate = DEFAULT_AGENT_PROMPT_TEMPLATE;
  return {
    id: newCanvasNodeId(),
    type: "agent",
    position: options.position ?? { x: 0, y: 0 },
    data: {
      kind: "agent",
      name: options.takenNames ? uniqueNodeName(preset.name, options.takenNames) : preset.name,
      isEntry: false,
      config,
      presetId: preset.id,
    },
  };
}

/** Unique node name: `base`, `base 2`, `base 3`, … against the taken set. */
export function uniqueNodeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// WorkflowGraph <-> CanvasDocument (1:1)
//

/** Graph → canvas: one node/edge each, entry marked with `isEntry`. */
export function toCanvasDocument(graph: WorkflowGraph): CanvasDocument {
  const nodes: CanvasNode[] = graph.nodes.map((node) => {
    if (node.type === "agent") {
      const agent = node as AgentGraphNode;
      return {
        id: agent.id,
        type: "agent" as const,
        position: agent.position,
        data: {
          kind: "agent" as const,
          name: agent.name,
          config: agent.config,
          isEntry: agent.id === graph.entryNodeId,
          ...(agent.presetId === undefined ? {} : { presetId: agent.presetId }),
        },
      };
    }
    if (node.type === "join") {
      const join = node as JoinGraphNode;
      return {
        id: join.id,
        type: "join" as const,
        position: join.position,
        data: { kind: "join" as const, name: join.name, config: join.config },
      };
    }
    const exit = node as ExitGraphNode;
    return {
      id: exit.id,
      type: "exit" as const,
      position: exit.position,
      data: { kind: "exit" as const, name: exit.name },
    };
  });
  const edges: CanvasEdge[] = graph.edges.map((edge) => {
    const { id, source, target, condition, order, maxIterations, invert } = edge;
    return {
      id,
      source,
      target,
      data: {
        condition,
        ...(order === undefined ? {} : { order }),
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(invert === undefined ? {} : { invert }),
      },
    };
  });
  return { nodes, edges };
}

/** Canvas → graph: passthrough; conditions/inverts copied verbatim. */
export function fromCanvasDocument(doc: CanvasDocument): WorkflowGraph {
  const nodes: GraphNode[] = doc.nodes.map((node) => {
    if (node.data.kind === "agent") {
      return {
        id: node.id,
        type: "agent" as const,
        name: node.data.name,
        position: node.position,
        config: node.data.config,
        ...(node.data.presetId === undefined ? {} : { presetId: node.data.presetId }),
      };
    }
    if (node.data.kind === "join") {
      return {
        id: node.id,
        type: "join" as const,
        name: node.data.name,
        position: node.position,
        config: node.data.config,
      };
    }
    return {
      id: node.id,
      type: "exit" as const,
      name: node.data.name,
      position: node.position,
    };
  });
  const edges: GraphEdge[] = doc.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    condition: edge.data.condition,
    ...(edge.data.order === undefined ? {} : { order: edge.data.order }),
    ...(edge.data.maxIterations === undefined ? {} : { maxIterations: edge.data.maxIterations }),
    ...(edge.data.invert === undefined ? {} : { invert: edge.data.invert }),
  }));
  const entry = doc.nodes.find((node) => node.data.kind === "agent" && node.data.isEntry);
  return { entryNodeId: entry ? entry.id : (doc.nodes[0]?.id ?? ""), nodes, edges };
}

/**
 * Editor dirty check: compares two documents by their serialized
 * `WorkflowGraph` projections, so React Flow runtime keys written onto nodes
 * and edges (`selected`, `measured`, `dragging`, `resizing`, …) never read
 * as unsaved changes — only graph-meaningful edits do.
 */
export function canvasDocsEquivalent(a: CanvasDocument, b: CanvasDocument): boolean {
  return JSON.stringify(fromCanvasDocument(a)) === JSON.stringify(fromCanvasDocument(b));
}

/**
 * The canvas document for a workflow as served by the daemon: its latest
 * revision graph when present, else one synthesized from the legacy steps
 * mirror (workflows written before revisions, or by older daemons).
 */
export function workflowToCanvasDocument(
  workflow: Workflow & {
    graph?: WorkflowGraph | undefined;
    latestRevision?: { id: string; number: number } | undefined;
  },
): CanvasDocument {
  if (workflow.graph !== undefined) return toCanvasDocument(workflow.graph);
  return toCanvasDocument(linearToGraph({ steps: workflow.steps, loopBack: workflow.loopBack }));
}

/** A minimal valid starter graph: one entry agent node prompted with {{task}}. */
export function starterGraph(driver = "opencode"): WorkflowGraphShape {
  return {
    entryNodeId: "entry",
    nodes: [
      {
        id: "entry",
        type: "agent",
        name: "Agent",
        position: { x: 80, y: 160 },
        config: {
          driver,
          mode: "auto",
          promptTemplate: "{{task}}",
          continueSession: false,
        },
      },
    ],
    edges: [],
  };
}
