import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  conflictBanner,
  conflictFromError,
  saveAfterConflict,
  type SaveConflictAction,
} from "./save-conflict";

const conflictError = (currentRevision?: number): ApiError =>
  new ApiError(
    "REVISION_CONFLICT",
    `workflow w1 is at revision ${currentRevision ?? "?"}`,
    409,
    currentRevision === undefined ? {} : { currentRevision },
  );

describe("conflictFromError", () => {
  it("maps a 409 REVISION_CONFLICT into dialog props naming both revisions", () => {
    const dialog = conflictFromError(conflictError(3), 1);
    expect(dialog).not.toBeNull();
    expect(dialog?.currentRevision).toBe(3);
    expect(dialog?.localRevision).toBe(1);
    expect(dialog?.title).toBe("Workflow updated elsewhere");
    expect(dialog?.message).toContain("revision 3 is current");
    expect(dialog?.message).toContain("you saved revision 1");
  });

  it("is null for anything that is not a revision-conflict 409", () => {
    // Wrong status, wrong code, network failure, plain objects.
    expect(conflictFromError(new ApiError("VALIDATION_ERROR", "bad graph", 422), 1)).toBeNull();
    expect(conflictFromError(new ApiError("WORKFLOW_IN_USE", "has runs", 409), 1)).toBeNull();
    expect(conflictFromError(new ApiError("NETWORK_ERROR", "offline", 0), 1)).toBeNull();
    expect(conflictFromError({ status: 409, code: "REVISION_CONFLICT" }, 1)).toBeNull();
    expect(conflictFromError(new Error("boom"), 1)).toBeNull();
  });

  it("is null when the 409 body did not name a current revision", () => {
    expect(conflictFromError(conflictError(), 1)).toBeNull();
  });
});

describe("saveAfterConflict", () => {
  it.each<[SaveConflictAction, boolean]>([
    ["save-anyway", true],
    ["reload", false],
  ])("%s → omitExpectedRevision=%s", (action, omit) => {
    expect(saveAfterConflict(action).omitExpectedRevision).toBe(omit);
  });
});

describe("conflictBanner", () => {
  it("warns when the server moved past the locally saved revision", () => {
    const banner = conflictBanner({ latestRevisionNumber: 5, savedRevision: 3 });
    expect(banner?.revision).toBe(5);
    expect(banner?.message).toContain("Revision 5");
    expect(banner?.message).toContain("saved elsewhere");
  });

  it("stays quiet when the editor is current or ahead", () => {
    expect(conflictBanner({ latestRevisionNumber: 3, savedRevision: 3 })).toBeNull();
    expect(conflictBanner({ latestRevisionNumber: 2, savedRevision: 3 })).toBeNull();
  });

  it("stays quiet without a known saved revision", () => {
    expect(conflictBanner({ latestRevisionNumber: 5, savedRevision: null })).toBeNull();
    expect(conflictBanner({ savedRevision: 3 })).toBeNull();
  });

  it("hides a dismissed revision but warns again for a newer one", () => {
    expect(
      conflictBanner({ latestRevisionNumber: 5, savedRevision: 3, dismissedRevision: 5 }),
    ).toBeNull();
    expect(
      conflictBanner({ latestRevisionNumber: 6, savedRevision: 3, dismissedRevision: 5 }),
    ).not.toBeNull();
  });
});
