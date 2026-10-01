import type { AgentPreset } from "@openeuler/core";
import type { CanvasDocument, CanvasNode, PresetSource } from "./canvas-document";

/**
 * Pure preset glue for the canvas editor (#49): the badge lookup behind
 * "from preset: X", and a bundle the editor passes around (palette +
 * inspector share one fetched roster). No React — headless-testable.
 */

/**
 * The preset a node was created from, for the inspector badge.
 *
 * Returns `undefined` when the node is plain/detached (no `presetId`) or
 * when the id no longer resolves — a deleted preset clears the badge
 * client-side while the node itself (config copy intact) keeps working.
 */
export function presetForNode(
  presets: readonly AgentPreset[],
  node: CanvasNode,
): AgentPreset | undefined {
  const presetId = node.data.kind === "agent" ? node.data.presetId : undefined;
  if (presetId === undefined) return undefined;
  return presets.find((preset) => preset.id === presetId);
}

/**
 * Nodes whose `presetId` references a preset missing from the roster
 * (deleted, or created in another scope). They render and save as plain
 * nodes — the caller only uses this to avoid showing a stale badge.
 */
export function nodesWithStalePreset(
  presets: readonly AgentPreset[],
  doc: CanvasDocument,
): CanvasNode[] {
  const ids = new Set(presets.map((preset) => preset.id));
  return doc.nodes.filter(
    (node) =>
      node.data.kind === "agent" && node.data.presetId !== undefined && !ids.has(node.data.presetId),
  );
}

/** View of a preset the palette renders (the roster minus config weight). */
export type PalettePreset = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  builtin?: boolean;
};

export function toPalettePreset(preset: AgentPreset): PalettePreset {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    ...(preset.icon === undefined ? {} : { icon: preset.icon }),
    ...(preset.builtin === undefined ? {} : { builtin: preset.builtin }),
  };
}

/** Narrow an {@link AgentPreset} to the slice {@link applyInspectorAction} needs. */
export function asPresetSource(preset: AgentPreset): PresetSource {
  return { id: preset.id, name: preset.name, config: preset.config };
}
