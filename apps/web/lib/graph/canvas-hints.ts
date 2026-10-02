import { DEFAULT_AGENT_PROMPT_TEMPLATE, type CanvasDocument } from "./canvas-document";

/**
 * Canvas onboarding hints (#77): a pure state machine over the document
 * shape deciding which coach hints are visible, plus localStorage
 * persistence for per-hint dismissal (`openeuler.canvasHints`). Browser-free
 * so the progression is trivially unit-testable; the editor only wires the
 * derived list into dismissible cards.
 */

/** Coach hint ids in onboarding order (first applicable wins in the UI). */
export type CanvasHintId = "drag" | "connect" | "configure";

/** localStorage key holding the JSON array of dismissed hint ids. */
export const CANVAS_HINTS_STORAGE_KEY = "openeuler.canvasHints";

export interface CanvasHint {
  id: CanvasHintId;
  /** One-line coach copy. */
  message: string;
  /** Optional second line (the drag hint's ⌘S save note). */
  saveNote?: string;
}

/** Inputs the machine needs — all derivable from the canvas document. */
export interface CanvasHintState {
  nodeCount: number;
  /** Any edge exists. */
  connectedOnce: boolean;
  /** Any agent node carries a non-default prompt edit. */
  hasConfiguredPrompt: boolean;
  /** Persisted dismissals (hint ids). */
  dismissed: readonly string[];
}

/**
 * Which coach hints are visible: each hint is gated by its own condition
 * (drag: under 2 nodes; connect: 2+ nodes and no edges yet; configure:
 * 2+ nodes and no prompt customized yet), minus dismissed ids, in
 * onboarding order [drag, connect, configure]. The UI renders the first
 * entry so at most one coach card shows at a time.
 */
export function visibleCanvasHints(state: CanvasHintState): CanvasHint[] {
  const dismissed = new Set(state.dismissed);
  const hints: CanvasHint[] = [];
  if (state.nodeCount < 2) {
    hints.push({
      id: "drag",
      message: "Drag an Agent step from the palette",
      // Once anything got wired together the user knows the connect move —
      // the remaining unknown is the save model, so the drag hint says so.
      ...(state.connectedOnce ? { saveNote: "then ⌘/Ctrl+S to save" } : {}),
    });
  }
  if (state.nodeCount >= 2 && !state.connectedOnce) {
    hints.push({ id: "connect", message: "Drag from a node's handle to connect the flow" });
  }
  if (state.nodeCount >= 2 && !state.hasConfiguredPrompt) {
    hints.push({ id: "configure", message: "Click a node to configure its prompt" });
  }
  return hints.filter((hint) => !dismissed.has(hint.id));
}

/** Prompt templates that read as "not customized yet". */
const DEFAULT_PROMPT_TEMPLATES: ReadonlySet<string> = new Set([
  "{{task}}",
  DEFAULT_AGENT_PROMPT_TEMPLATE,
]);

/**
 * Document → `hasConfiguredPrompt`: true when any agent node's prompt
 * drifted off a default template (the starter `{{task}}` or the palette's
 * drop-in default). Whitespace-only edits don't count.
 */
export function docHasConfiguredPrompt(doc: CanvasDocument): boolean {
  return doc.nodes.some(
    (node) =>
      node.data.kind === "agent" &&
      !DEFAULT_PROMPT_TEMPLATES.has(node.data.config.promptTemplate.trim()),
  );
}

/** Minimal storage surface so tests can pass an in-memory stub. */
export interface CanvasHintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the dismissed hint ids from localStorage. Tolerant by design: junk
 * (parse errors, wrong shapes, unavailable storage) reads as "nothing
 * dismissed" rather than breaking the editor.
 */
export function loadDismissedCanvasHints(storage: CanvasHintStorage | null): string[] {
  if (storage === null) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(CANVAS_HINTS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Persist the dismissed hint ids; failures (quota, private mode) stay quiet. */
export function saveDismissedCanvasHints(
  storage: CanvasHintStorage | null,
  dismissed: readonly string[],
): void {
  if (storage === null) return;
  try {
    storage.setItem(CANVAS_HINTS_STORAGE_KEY, JSON.stringify(dismissed));
  } catch {
    // Hint persistence is a nicety, never a blocker.
  }
}
