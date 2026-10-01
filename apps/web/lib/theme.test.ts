import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  persistTheme,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
  };
}

describe("resolveTheme", () => {
  it("defaults to dark", () => {
    expect(resolveTheme(null)).toBe("dark");
    expect(resolveTheme("")).toBe("dark");
  });

  it("only accepts light as an override", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("Light")).toBe("dark");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("banana")).toBe("dark");
  });
});

describe("readStoredTheme", () => {
  it("returns dark when nothing is stored", () => {
    expect(readStoredTheme(memoryStorage())).toBe("dark");
  });

  it("returns the stored light preference", () => {
    expect(readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
  });

  it("falls back to dark when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => undefined,
    };
    expect(readStoredTheme(broken)).toBe("dark");
  });
});

describe("persistTheme", () => {
  it("writes the theme under the storage key", () => {
    const storage = memoryStorage();
    persistTheme(storage, "light");
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
  });

  it("swallows storage failures", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("nope");
      },
    };
    expect(() => persistTheme(broken, "light")).not.toThrow();
  });
});

describe("applyTheme", () => {
  it("sets data-theme on the document element", () => {
    const doc = { documentElement: { dataset: { theme: "dark" } } };
    applyTheme(doc, "light");
    expect(doc.documentElement.dataset.theme).toBe("light");
    applyTheme(doc, "dark");
    expect(doc.documentElement.dataset.theme).toBe("dark");
  });
});

describe("toggleTheme", () => {
  it("flips between dark and light", () => {
    expect(toggleTheme("dark")).toBe("light");
    expect(toggleTheme("light")).toBe("dark");
  });
});
