import { describe, expect, it } from "vitest";
import { saveStatus, type SaveStatusState } from "./save-status";

describe("saveStatus state machine (#75)", () => {
  it("a pristine, never-saved doc reads clean", () => {
    expect(saveStatus({ dirty: false, saving: false })).toEqual({
      kind: "clean",
      label: "No changes",
    });
  });

  it("dirty → unsaved", () => {
    const state: SaveStatusState = { dirty: true, saving: false };
    expect(saveStatus(state)).toEqual({ kind: "unsaved", label: "Unsaved changes" });
  });

  it("saving wins over every other flag", () => {
    expect(saveStatus({ dirty: true, saving: true })).toEqual({
      kind: "saving",
      label: "Saving…",
    });
    expect(saveStatus({ dirty: false, saving: true, error: true, savedRevision: 3 })).toEqual({
      kind: "saving",
      label: "Saving…",
    });
  });

  it("a settled failure reads error, even though the doc is still dirty", () => {
    expect(saveStatus({ dirty: true, saving: false, error: true })).toEqual({
      kind: "error",
      label: "Save failed",
    });
    // A prior successful save does not soften a later failure.
    expect(saveStatus({ dirty: true, saving: false, error: true, savedRevision: 3 })).toEqual({
      kind: "error",
      label: "Save failed",
    });
  });

  it("a clean doc with a session save names the revision", () => {
    expect(saveStatus({ dirty: false, saving: false, savedRevision: 7 })).toEqual({
      kind: "saved",
      label: "Saved · revision 7",
    });
  });

  it("full lifecycle: clean → unsaved → saving → saved → unsaved again", () => {
    expect(saveStatus({ dirty: false, saving: false, savedRevision: null })).toEqual({
      kind: "clean",
      label: "No changes",
    });
    expect(saveStatus({ dirty: true, saving: false, savedRevision: null })).toEqual({
      kind: "unsaved",
      label: "Unsaved changes",
    });
    expect(saveStatus({ dirty: true, saving: true, savedRevision: null })).toEqual({
      kind: "saving",
      label: "Saving…",
    });
    const landed = saveStatus({ dirty: false, saving: false, savedRevision: 2 });
    expect(landed).toEqual({ kind: "saved", label: "Saved · revision 2" });
    // The next edit flips it straight back to unsaved — the revision note
    // is stale the moment the doc diverges again.
    expect(saveStatus({ dirty: true, saving: false, savedRevision: 2 })).toEqual({
      kind: "unsaved",
      label: "Unsaved changes",
    });
  });

  it("a new save attempt clears the error view (saving replaces failure)", () => {
    expect(saveStatus({ dirty: true, saving: false, error: true })).toEqual({
      kind: "error",
      label: "Save failed",
    });
    expect(saveStatus({ dirty: true, saving: true, error: false })).toEqual({
      kind: "saving",
      label: "Saving…",
    });
  });
});
