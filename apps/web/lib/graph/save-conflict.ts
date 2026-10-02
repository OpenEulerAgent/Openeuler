import { ApiError } from "@/lib/api";

/**
 * Pure save-conflict machine (#76): maps a failed save's 409
 * REVISION_CONFLICT response (plus the editor's local revision state) to
 * the conflict dialog's view-model, resolves the user's chosen action into
 * the next save's behavior, and derives the focus-probe "saved elsewhere"
 * banner. No React, no timers — the editor component only owns the state.
 */

/** View-model for the non-blocking conflict dialog. */
export interface SaveConflictDialog {
  /** The server's current latest revision (N in "revision N is current"). */
  currentRevision: number;
  /** The revision this editor based its doc on (M in "you saved revision M"). */
  localRevision: number | null;
  title: string;
  message: string;
}

/**
 * Detect a revision-conflict 409 and build the dialog props. Any other
 * failure (validation 422, network, unrelated 409s) is not a conflict and
 * returns null so the editor keeps its generic failure handling.
 */
export function conflictFromError(
  error: unknown,
  localRevision: number | null,
): SaveConflictDialog | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409 || error.code !== "REVISION_CONFLICT") return null;
  // The daemon always names the current revision; without it there is
  // nothing actionable to render — treat it as a generic failure.
  if (typeof error.currentRevision !== "number") return null;
  const currentRevision = error.currentRevision;
  return {
    currentRevision,
    localRevision,
    title: "Workflow updated elsewhere",
    message: `This workflow was updated elsewhere (revision ${currentRevision} is current; you saved revision ${localRevision ?? "none"}).`,
  };
}

/** The two ways out of the conflict dialog. */
export type SaveConflictAction = "reload" | "save-anyway";

/** How the save following a conflict resolution must be issued. */
export interface SaveAfterConflict {
  /**
   * True for "Save anyway": the re-PUT omits `expectedRevision`, forcing a
   * new revision from the local doc. "Reload" re-bases the editor on the
   * server revision first, so its next save pins that revision again.
   */
  omitExpectedRevision: boolean;
}

/** Resolve a conflict dialog action into the next save's behavior. */
export function saveAfterConflict(action: SaveConflictAction): SaveAfterConflict {
  return { omitExpectedRevision: action === "save-anyway" };
}

/** View-model for the dismissible header banner. */
export interface SaveConflictBanner {
  /** The revision saved elsewhere. */
  revision: number;
  message: string;
}

/**
 * Focus-probe banner condition (#76): warn when the server moved past the
 * revision this editor is based on. Hidden once dismissed for that exact
 * revision (a newer one warns again) and self-clearing as soon as the
 * editor catches up (reload, or a successful save minting a newer one).
 */
export function conflictBanner(server: {
  latestRevisionNumber?: number;
  savedRevision: number | null;
  dismissedRevision?: number | null;
}): SaveConflictBanner | null {
  const { latestRevisionNumber, savedRevision, dismissedRevision } = server;
  if (savedRevision === null || latestRevisionNumber === undefined) return null;
  if (latestRevisionNumber <= savedRevision) return null;
  if (dismissedRevision === latestRevisionNumber) return null;
  return {
    revision: latestRevisionNumber,
    message: `Revision ${latestRevisionNumber} was saved elsewhere`,
  };
}
