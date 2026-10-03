import {
  AgentGraphNodeSchema,
  SubworkflowGraphNodeSchema,
  extractOutputReferences,
  renderPromptTemplate,
  type PromptTemplateVars,
  type StepConfig,
} from "@openeuler/core";
import type { PresetSource, CanvasDocument, CanvasNode } from "./canvas-document";

/**
 * Pure logic behind the agent node inspector (#47): upstream computation for
 * the `{{output:<nodeId>}}` picker, variable insertion into the prompt
 * textarea, the live sample-data prompt preview, per-field inline validation,
 * and the doc-editing reducer the drawer dispatches into. No React — all of
 * it is unit-testable headlessly.
 */

/** Sample task the preview renders `{{task}}` with. */
export const PREVIEW_SAMPLE_TASK = "Summarize this repository's recent changes";

/** What the preview shows for `{{prevOutput}}` (no upstream context yet). */
export const PREVIEW_SAMPLE_PREV_OUTPUT = "<output of the previous step>";

/** Dummy output the preview renders an `{{output:<nodeId>}}` reference with. */
export function previewSampleOutput(node: { name: string }): string {
  return `<output of "${node.name.length > 0 ? node.name : "Untitled agent"}">`;
}

/**
 * Nodes with a path (over any edges, conditional or not) into `nodeId`,
 * excluding `nodeId` itself — exactly the reference set core's
 * `validateWorkflowGraph` allows in `{{output:…}}` templates. Returned in
 * document order for a stable picker.
 */
export function upstreamNodes(doc: CanvasDocument, nodeId: string): CanvasNode[] {
  const incoming = new Map<string, string[]>();
  const known = new Set(doc.nodes.map((node) => node.id));
  for (const edge of doc.edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const bucket = incoming.get(edge.target);
    if (bucket === undefined) incoming.set(edge.target, [edge.source]);
    else bucket.push(edge.source);
  }
  const upstreamIds = new Set<string>();
  const queue = [...(incoming.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (next === nodeId || upstreamIds.has(next)) continue;
    upstreamIds.add(next);
    queue.push(...(incoming.get(next) ?? []));
  }
  return doc.nodes.filter((node) => upstreamIds.has(node.id));
}

/** Outcome of inserting a variable token at a caret position. */
export interface InsertVariableResult {
  template: string;
  /** Caret position just after the inserted token. */
  caret: number;
}

/** Inserts `token` at `at` (clamped), reporting the post-insert caret. */
export function insertPromptVariable(
  template: string,
  token: string,
  at: number,
): InsertVariableResult {
  const index = Math.max(0, Math.min(at, template.length));
  return {
    template: template.slice(0, index) + token + template.slice(index),
    caret: index + token.length,
  };
}

/** Live preview outcome: the rendered prompt, or the friendly render error. */
export type PromptPreviewResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Renders the template against sample data so users see exactly what the
 * agent receives: a sample task, iteration 1, and a dummy output per
 * upstream node (`<output of "Implement">`). `renderPromptTemplate`'s
 * failures — an `{{output:…}}` reference with no sample output (i.e. a
 * non-upstream node) or an unknown variable — surface as the friendly error
 * instead of throwing.
 */
export function previewPromptTemplate(
  template: string,
  upstream: readonly { id: string; name: string }[],
  overrides: Partial<PromptTemplateVars> = {},
): PromptPreviewResult {
  const outputs: Record<string, string> = {};
  for (const node of upstream) outputs[node.id] = previewSampleOutput(node);
  const vars: PromptTemplateVars = {
    task: PREVIEW_SAMPLE_TASK,
    prevOutput: PREVIEW_SAMPLE_PREV_OUTPUT,
    iterations: 1,
    outputs,
    ...overrides,
  };
  try {
    return { ok: true, text: renderPromptTemplate(template, vars) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Fields of the inspected node the drawer flags inline. */
export type InspectorField =
  | "name"
  | "config.driver"
  | "config.model"
  | "config.promptTemplate"
  | "config.sandboxOverrides.image"
  | "config.sandboxOverrides.cpus"
  | "config.sandboxOverrides.memoryMb"
  | "config.sandboxOverrides.network"
  | "config.workflowId"
  | "config.revision";

export type InspectorFieldErrors = Partial<Record<InspectorField, string>>;

/**
 * Live per-field errors for the inspected node, reusing core's zod schemas
 * (`AgentGraphNodeSchema` → `StepConfigSchema`) plus the graph-level rule
 * that `{{output:<nodeId>}}` must reference an upstream node — surfaced on
 * the prompt field so typing feedback is immediate, before any save attempt.
 * Sub-workflow nodes (#117) validate through `SubworkflowGraphNodeSchema`
 * (an unconfigured `workflowId` flags that field).
 */
export function inspectorFieldErrors(doc: CanvasDocument, nodeId: string): InspectorFieldErrors {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return {};
  if (node.data.kind === "subworkflow") {
    const errors: InspectorFieldErrors = {};
    const parsed = SubworkflowGraphNodeSchema.safeParse({
      id: node.id,
      type: "subworkflow",
      name: node.data.name,
      position: node.position,
      config: node.data.config,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join(".");
        if (field === "name" || field === "config.workflowId" || field === "config.revision") {
          errors[field as InspectorField] ??= issue.message;
        }
      }
    }
    return errors;
  }
  if (node.data.kind !== "agent") return {};

  const errors: InspectorFieldErrors = {};
  const parsed = AgentGraphNodeSchema.safeParse({
    id: node.id,
    type: "agent",
    name: node.data.name,
    position: node.position,
    config: node.data.config,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".");
      if (field === "name" || field === "config.driver" || field === "config.model") {
        errors[field] ??= issue.message;
      }
      // The empty-prompt zod error; graph-level template checks below merge in.
      if (field === "config.promptTemplate") {
        errors[field] ??= issue.message;
      }
      // Sandbox overrides (#101): clamp/rule errors surface on their fields.
      if (field.startsWith("config.sandboxOverrides.")) {
        errors[field as InspectorField] ??= issue.message;
      }
    }
  }

  const upstream = new Set(upstreamNodes(doc, nodeId).map((candidate) => candidate.id));
  const badRefs = extractOutputReferences(node.data.config.promptTemplate).filter(
    (ref) => !upstream.has(ref),
  );
  if (badRefs.length > 0) {
    const label = upstream.size > 0 ? [...upstream].join(", ") : "none yet";
    const detail =
      badRefs.length === 1
        ? `{{output:${badRefs[0]}}} is not an upstream node of this step (upstream: ${label})`
        : `${badRefs.map((ref) => `{{output:${ref}}}`).join(", ")} are not upstream nodes of this step (upstream: ${label})`;
    errors["config.promptTemplate"] = [errors["config.promptTemplate"], detail]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" — ");
  }

  return errors;
}

/** Inspector edits as doc transitions — the reducer the drawer drives. */
export type InspectorAction =
  | { type: "patchName"; nodeId: string; name: string }
  | { type: "patchConfig"; nodeId: string; patch: Partial<StepConfig> }
  /**
   * Join mode toggle (#116): `all` waits for every branch, `any` fires on
   * the first winner and cancels the losers. Join nodes carry no other
   * editable config.
   */
  | { type: "patchJoinMode"; nodeId: string; mode: "all" | "any" }
  /**
   * Sub-workflow picker (#117): sets which workflow the node spawns and how
   * its revision is pinned (`'latest'` or an exact number). Switching the
   * workflow resets the revision to `'latest'`.
   */
  | { type: "patchSubworkflow"; nodeId: string; workflowId?: string; revision?: "latest" | number }
  | { type: "insertVariable"; nodeId: string; token: string; at: number }
  /**
   * Detach from the preset (#49): drops `presetId`, keeps the node's config
   * copy exactly as it is — the node becomes a plain node.
   */
  | { type: "detachPreset"; nodeId: string }
  /**
   * "Update from preset" (#49): explicit sync. Copies the preset's CURRENT
   * config (deep) and name into the node; id, position, and edges stay.
   */
  | { type: "applyPreset"; nodeId: string; preset: PresetSource };

/**
 * Merges a patch into a config: `undefined` values clear their key (e.g.
 * emptying the model field), so configs never linger with
 * explicit-undefined keys.
 */
function mergeConfig(config: StepConfig, patch: Partial<StepConfig>): StepConfig {
  const merged = { ...config, ...patch };
  for (const key of Object.keys(merged)) {
    if (merged[key as keyof StepConfig] === undefined) delete merged[key as keyof StepConfig];
  }
  return merged;
}

/** Applies an inspector action to the document (unknown nodes are no-ops). */
export function applyInspectorAction(doc: CanvasDocument, action: InspectorAction): CanvasDocument {
  const node = doc.nodes.find((candidate) => candidate.id === action.nodeId);
  if (node === undefined) return doc;

  if (action.type === "patchName") {
    return {
      ...doc,
      nodes: doc.nodes.map((candidate) =>
        candidate.id === action.nodeId
          ? { ...candidate, data: { ...candidate.data, name: action.name } }
          : candidate,
      ),
    };
  }

  if (action.type === "detachPreset") {
    if (node.data.kind !== "agent" || node.data.presetId === undefined) return doc;
    return {
      ...doc,
      nodes: doc.nodes.map((candidate) => {
        if (candidate.id !== action.nodeId || candidate.data.kind !== "agent") return candidate;
        // Drop the provenance key, keep the config copy verbatim.
        const data: Record<string, unknown> = { ...candidate.data };
        delete data["presetId"];
        return { ...candidate, data } as CanvasNode;
      }),
    };
  }

  if (action.type === "applyPreset") {
    if (node.data.kind !== "agent") return doc;
    return {
      ...doc,
      nodes: doc.nodes.map((candidate) =>
        candidate.id === action.nodeId && candidate.data.kind === "agent"
          ? {
              ...candidate,
              data: {
                ...candidate.data,
                name: action.preset.name,
                config: structuredClone(action.preset.config),
                presetId: action.preset.id,
              },
            }
          : candidate,
      ),
    };
  }

  if (action.type === "patchJoinMode") {
    if (node.data.kind !== "join") return doc;
    return {
      ...doc,
      nodes: doc.nodes.map((candidate) =>
        candidate.id === action.nodeId && candidate.data.kind === "join"
          ? { ...candidate, data: { ...candidate.data, config: { mode: action.mode } } }
          : candidate,
      ),
    };
  }

  if (action.type === "patchSubworkflow") {
    if (node.data.kind !== "subworkflow") return doc;
    return {
      ...doc,
      nodes: doc.nodes.map((candidate) => {
        if (candidate.id !== action.nodeId || candidate.data.kind !== "subworkflow") {
          return candidate;
        }
        const workflowId = action.workflowId ?? candidate.data.config.workflowId;
        const revision =
          action.workflowId !== undefined && action.workflowId !== candidate.data.config.workflowId
            ? "latest"
            : (action.revision ?? candidate.data.config.revision);
        return {
          ...candidate,
          data: { ...candidate.data, config: { workflowId, revision } },
        };
      }),
    };
  }

  if (node.data.kind !== "agent") return doc;
  const patch: Partial<StepConfig> =
    action.type === "patchConfig"
      ? action.patch
      : {
          promptTemplate: insertPromptVariable(
            node.data.config.promptTemplate,
            action.token,
            action.at,
          ).template,
        };

  return {
    ...doc,
    nodes: doc.nodes.map((candidate) =>
      candidate.id === action.nodeId && candidate.data.kind === "agent"
        ? {
            ...candidate,
            data: {
              ...candidate.data,
              config: mergeConfig(candidate.data.config, patch),
            },
          }
        : candidate,
    ),
  };
}

/** Reducer form of {@link applyInspectorAction} (dispatch surface for tests/UX). */
export function inspectorReducer(doc: CanvasDocument, action: InspectorAction): CanvasDocument {
  return applyInspectorAction(doc, action);
}
