/**
 * Pure save-status derivation for the canvas editor's persistent chip
 * (#75): maps the editor's raw save flags to the single status the user
 * should see next to the Save button. No React, no timers — the "saved"
 * fade-to-muted is a component concern; this stays deterministic and
 * unit-testable.
 */

export interface SaveStatusState {
  /** The doc differs from the last saved revision. */
  dirty: boolean;
  /** A save PUT is in flight. */
  saving: boolean;
  /** Revision number minted by the last successful save this session. */
  savedRevision?: number | null;
  /** The last save attempt failed (network or daemon rejection). */
  error?: boolean;
}

export type SaveStatusKind = "clean" | "unsaved" | "saving" | "saved" | "error";

export interface SaveStatusView {
  kind: SaveStatusKind;
  label: string;
}

/**
 * Derive the chip status. Precedence reflects what the user most needs to
 * know right now: an in-flight save ("Saving…") outranks everything; once
 * it settles, a failure ("Save failed") outranks the still-dirty state
 * (the failure explains the dirt); a clean doc with a session save reads
 * "Saved · revision N" until the next edit flips it back to unsaved; a
 * clean doc with no session save reads "No changes".
 */
export function saveStatus(state: SaveStatusState): SaveStatusView {
  if (state.saving) return { kind: "saving", label: "Saving…" };
  if (state.error === true) return { kind: "error", label: "Save failed" };
  if (state.dirty) return { kind: "unsaved", label: "Unsaved changes" };
  if (typeof state.savedRevision === "number") {
    return { kind: "saved", label: `Saved · revision ${state.savedRevision}` };
  }
  return { kind: "clean", label: "No changes" };
}
