import { describe, expect, it } from "vitest";
import {
  authorizationHeaderValue,
  clearStoredToken,
  getStoredToken,
  storeToken,
  TOKEN_STORAGE_KEY,
  __resetMemoryToken,
} from "./token";

/** Minimal Storage stand-in (node env has no localStorage). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("token store (#92)", () => {
  it("stores and reads back the token under the documented key", () => {
    const storage = memoryStorage();
    storeToken("  tok-en  ", storage);
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe("tok-en");
    expect(getStoredToken(storage)).toBe("tok-en");
  });

  it("clears the stored token", () => {
    const storage = memoryStorage();
    storeToken("tok-en", storage);
    clearStoredToken(storage);
    expect(getStoredToken(storage)).toBeNull();
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("treats empty/whitespace values as absent", () => {
    const storage = memoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "   ");
    expect(getStoredToken(storage)).toBeNull();
  });

  it("returns null with no storage available (SSR)", () => {
    expect(getStoredToken(undefined)).toBeNull();
  });

  it("falls back to memory when storage writes throw (private mode)", () => {
    __resetMemoryToken();
    const throwing: Storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    expect(() => storeToken("mem-tok", throwing)).not.toThrow();
    expect(getStoredToken(throwing)).toBe("mem-tok");
    clearStoredToken(throwing);
    expect(getStoredToken(throwing)).toBeNull();
  });
});

describe("authorizationHeaderValue", () => {
  it("builds a Bearer value and skips empty/absent tokens", () => {
    expect(authorizationHeaderValue("tok-en")).toBe("Bearer tok-en");
    expect(authorizationHeaderValue("  tok-en  ")).toBe("Bearer tok-en");
    expect(authorizationHeaderValue(null)).toBeUndefined();
    expect(authorizationHeaderValue(undefined)).toBeUndefined();
    expect(authorizationHeaderValue("   ")).toBeUndefined();
  });
});
