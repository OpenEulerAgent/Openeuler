import { describe, expect, it, vi } from "vitest";
import {
  applySidebarPreference,
  persistSidebar,
  readStoredSidebar,
  resolveSidebarPreference,
  SIDEBAR_INIT_SCRIPT,
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

describe("applySidebarPreference", () => {
  it("sets data-sidebar on the document element (pre-paint script mirrors this)", () => {
    const doc = { documentElement: { dataset: { sidebar: "expanded" } } };
    applySidebarPreference(doc, "collapsed");
    expect(doc.documentElement.dataset.sidebar).toBe("collapsed");
    applySidebarPreference(doc, "expanded");
    expect(doc.documentElement.dataset.sidebar).toBe("expanded");
  });
});

describe("SIDEBAR_INIT_SCRIPT (pre-paint, no expanded flash)", () => {
  it("applies the stored collapsed preference to <html data-sidebar>", () => {
    const documentElement = { dataset: {} as Record<string, string> };
    runInitScript({ "openeuler-sidebar": "collapsed" }, documentElement);
    expect(documentElement.dataset.sidebar).toBe("collapsed");
  });

  it("defaults to expanded for missing or invalid stored values", () => {
    for (const stored of [null, "junk"]) {
      const documentElement = { dataset: {} as Record<string, string> };
      runInitScript({ "openeuler-sidebar": stored }, documentElement);
      expect(documentElement.dataset.sidebar).toBe("expanded");
    }
  });

  it("never throws when localStorage is unavailable", () => {
    expect(() => runInitScript(null, { dataset: {} })).not.toThrow();
  });
});

/** Execute the raw init script with stubbed localStorage/documentElement. */
function runInitScript(
  storage: Record<string, string | null> | null,
  documentElement: { dataset: Record<string, string> },
): void {
  const win = {
    localStorage: storage === null ? undefined : { getItem: (key: string) => storage[key] ?? null },
    document: { documentElement },
  };
  new Function(`with (this) { ${SIDEBAR_INIT_SCRIPT} }`).call(win);
}
