import { describe, expect, it, vi } from "vitest";
import {
  persistSidebar,
  readStoredSidebar,
  resolveSidebarPreference,
  SIDEBAR_STORAGE_KEY,
  toggleSidebarPreference,
} from "./sidebar";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
  };
}

describe("resolveSidebarPreference", () => {
  it("defaults to expanded", () => {
    expect(resolveSidebarPreference(null)).toBe("expanded");
    expect(resolveSidebarPreference("expanded")).toBe("expanded");
  });

  it("recognizes collapsed", () => {
    expect(resolveSidebarPreference("collapsed")).toBe("collapsed");
    expect(resolveSidebarPreference("Collapsed")).toBe("expanded");
  });
});

describe("readStoredSidebar", () => {
  it("restores a persisted collapse", () => {
    expect(readStoredSidebar(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "collapsed" }))).toBe(
      "collapsed",
    );
  });

  it("falls back to expanded on garbage or throwing storage", () => {
    expect(readStoredSidebar(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "junk" }))).toBe("expanded");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    expect(readStoredSidebar(broken)).toBe("expanded");
  });
});

describe("persistSidebar", () => {
  it("writes the preference under the storage key", () => {
    const storage = memoryStorage();
    persistSidebar(storage, "collapsed");
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_STORAGE_KEY, "collapsed");
  });

  it("swallows storage failures", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("nope");
      },
    };
    expect(() => persistSidebar(broken, "collapsed")).not.toThrow();
  });
});

describe("toggleSidebarPreference", () => {
  it("flips both ways (persistence across reloads relies on this)", () => {
    expect(toggleSidebarPreference("expanded")).toBe("collapsed");
    expect(toggleSidebarPreference("collapsed")).toBe("expanded");
  });
});
