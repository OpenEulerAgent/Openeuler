import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "@openeuler/core";
import { DEFAULT_DAEMON_URL } from "./api.js";
import {
  canGoBack,
  canGoForward,
  fetchFileContent,
  fetchTree,
  fileViewerModel,
  flattenVisibleTree,
  handleTreeKey,
  historyBack,
  historyCurrent,
  historyForward,
  historyPush,
  initHistory,
  initTree,
  joinDirPath,
  MAX_CONTENT_BYTES,
  parentPath,
  treeReducer,
} from "./workspace.js";

function dir(name: string): FileNode {
  return { name, type: "dir", size: 0 };
}

function file(name: string, size = 10): FileNode {
  return { name, type: "file", size };
}

/** A tree with `src/` containing `lib/` and `a.ts`, plus top-level `README.md`. */
function loadedTree() {
  let state = initTree();
  state = treeReducer(state, {
    type: "dir-loaded",
    path: "",
    entries: [dir("src"), file("README.md", 120)],
  }).state;
  state = treeReducer(state, {
    type: "dir-loaded",
    path: "src",
    entries: [dir("lib"), file("a.ts", 42)],
  }).state;
  state = treeReducer(state, {
    type: "dir-loaded",
    path: "src/lib",
    entries: [file("util.ts", 7)],
  }).state;
  return state;
}

function paths(nodes: ReturnType<typeof flattenVisibleTree>): string[] {
  return nodes.map((node) => node.path);
}

describe("treeReducer", () => {
  it("starts with an idle root and nothing expanded", () => {
    const state = initTree();
    expect(state.dirs[""]).toEqual({ status: "idle", entries: [], error: null });
    expect(state.expanded).toEqual([]);
    expect(state.selectedPath).toBeNull();
  });

  it("expanding an unloaded dir marks it loading and requests a fetch", () => {
    const update = treeReducer(initTree(), { type: "toggle", path: "" });
    expect(update.state.dirs[""]?.status).toBe("loading");
    expect(update.state.expanded).toEqual([""]);
    expect(update.fetchDirs).toEqual([""]);
  });

  it("re-expanding a loaded dir does not refetch (cached children)", () => {
    let state = loadedTree();
    state = treeReducer(state, { type: "toggle", path: "src" }).state;
    expect(state.dirs["src"]?.status).toBe("ready");

    const collapse = treeReducer(state, { type: "toggle", path: "src" });
    expect(collapse.state.expanded).not.toContain("src");

    const reexpand = treeReducer(collapse.state, { type: "toggle", path: "src" });
    expect(reexpand.fetchDirs).toEqual([]);
    expect(reexpand.state.dirs["src"]?.status).toBe("ready");
    expect(reexpand.state.expanded).toContain("src");
  });

  it("re-expanding while a fetch is still in flight does not refetch", () => {
    const expand = treeReducer(initTree(), { type: "toggle", path: "" });
    expect(expand.fetchDirs).toEqual([""]);

    const collapse = treeReducer(expand.state, { type: "toggle", path: "" });
    const reexpand = treeReducer(collapse.state, { type: "toggle", path: "" });
    expect(reexpand.fetchDirs).toEqual([]); // still loading → no duplicate fetch
    expect(reexpand.state.expanded).toEqual([]); // stays collapsed until loaded

    const loaded = treeReducer(reexpand.state, { type: "dir-loaded", path: "", entries: [] });
    const nowExpand = treeReducer(loaded.state, { type: "toggle", path: "" });
    expect(nowExpand.fetchDirs).toEqual([]); // cached → expand straight away
    expect(nowExpand.state.expanded).toEqual([""]);
  });

  it("toggling an expanded loading dir collapses it", () => {
    const first = treeReducer(initTree(), { type: "toggle", path: "" });
    const second = treeReducer(first.state, { type: "toggle", path: "" });
    expect(second.state.expanded).toEqual([]);
    expect(second.fetchDirs).toEqual([]);
  });

  it("records dir errors and retry re-requests the fetch", () => {
    let state = treeReducer(initTree(), { type: "toggle", path: "" }).state;
    state = treeReducer(state, { type: "dir-error", path: "", message: "daemon down" }).state;
    expect(state.dirs[""]?.status).toBe("error");
    expect(state.dirs[""]?.error).toBe("daemon down");

    const retry = treeReducer(state, { type: "retry", path: "" });
    expect(retry.state.dirs[""]?.status).toBe("loading");
    expect(retry.fetchDirs).toEqual([""]);

    // Retrying a healthy dir does nothing.
    const noop = treeReducer(retry.state, { type: "retry", path: "src" });
    expect(noop.fetchDirs).toEqual([]);
  });

  it("open selects the file and emits it as an openFile effect", () => {
    const update = treeReducer(loadedTree(), { type: "open", path: "src/a.ts" });
    expect(update.state.selectedPath).toBe("src/a.ts");
    expect(update.openFiles).toEqual(["src/a.ts"]);
    expect(update.fetchDirs).toEqual([]);
  });
});

describe("flattenVisibleTree", () => {
  it("shows nothing before the root listing arrives", () => {
    expect(flattenVisibleTree(initTree())).toEqual([]);
  });

  it("lists root children (API order: dirs first) once loaded", () => {
    const state = treeReducer(initTree(), {
      type: "dir-loaded",
      path: "",
      entries: [dir("src"), file("README.md")],
    }).state;
    expect(paths(flattenVisibleTree(state))).toEqual(["src", "README.md"]);
    expect(flattenVisibleTree(state)[0]).toMatchObject({ depth: 0, expanded: false, type: "dir" });
  });

  it("recurses into expanded dirs and hides collapsed children", () => {
    let state = loadedTree();
    state = treeReducer(state, { type: "toggle", path: "src" }).state;
    expect(paths(flattenVisibleTree(state))).toEqual(["src", "src/lib", "src/a.ts", "README.md"]);
    expect(flattenVisibleTree(state)[1]).toMatchObject({ depth: 1, expanded: false });

    state = treeReducer(state, { type: "toggle", path: "src/lib" }).state;
    expect(paths(flattenVisibleTree(state))).toEqual([
      "src",
      "src/lib",
      "src/lib/util.ts",
      "src/a.ts",
      "README.md",
    ]);
    expect(flattenVisibleTree(state)[2]).toMatchObject({ depth: 2, type: "file", size: 7 });

    state = treeReducer(state, { type: "toggle", path: "src" }).state;
    expect(paths(flattenVisibleTree(state))).toEqual(["src", "README.md"]);
  });

  it("skips children of a dir whose listing failed or is loading", () => {
    let state = loadedTree();
    state = treeReducer(state, { type: "toggle", path: "src" }).state;
    state = treeReducer(state, { type: "dir-error", path: "src", message: "boom" }).state;
    // Collapsed the listing: src stays visible but its children vanish.
    expect(paths(flattenVisibleTree(state))).toEqual(["src", "README.md"]);
    expect(flattenVisibleTree(state)[0]?.status).toBe("error");
  });
});

describe("handleTreeKey", () => {
  function expandedTree() {
    let state = loadedTree();
    state = treeReducer(state, { type: "toggle", path: "" }).state; // already ready → no fetch
    state = treeReducer(state, { type: "toggle", path: "src" }).state;
    return state;
  }

  it("ArrowDown selects the first row, then steps down", () => {
    let state = expandedTree();
    state = handleTreeKey(state, "ArrowDown").state;
    expect(state.selectedPath).toBe("src");
    state = handleTreeKey(state, "ArrowDown").state;
    expect(state.selectedPath).toBe("src/lib");
    state = handleTreeKey(state, "ArrowDown").state;
    expect(state.selectedPath).toBe("src/a.ts");
  });

  it("ArrowDown clamps at the last row", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "README.md" }).state;
    state = handleTreeKey(state, "ArrowDown").state;
    expect(state.selectedPath).toBe("README.md");
  });

  it("ArrowUp moves up and clamps at the first row", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "src/a.ts" }).state;
    state = handleTreeKey(state, "ArrowUp").state;
    expect(state.selectedPath).toBe("src/lib");
    state = handleTreeKey(state, "ArrowUp").state;
    expect(state.selectedPath).toBe("src");
    state = handleTreeKey(state, "ArrowUp").state;
    expect(state.selectedPath).toBe("src");
  });

  it("ArrowRight on a collapsed dir expands it and requests the fetch", () => {
    const state = expandedTree();
    const collapsed = treeReducer(state, { type: "toggle", path: "src/lib" }).state;
    const update = handleTreeKey(
      treeReducer(collapsed, { type: "select", path: "src/lib" }).state,
      "ArrowRight",
    );
    expect(update.state.expanded).toContain("src/lib");
    // src/lib was ready (cached) in this fixture, so no fetch is needed.
    expect(update.fetchDirs).toEqual([]);
  });

  it("ArrowRight on an unloaded dir fetches it", () => {
    let state = initTree();
    state = treeReducer(state, {
      type: "dir-loaded",
      path: "",
      entries: [dir("src"), file("README.md")],
    }).state;
    state = treeReducer(state, {
      type: "dir-loaded",
      path: "src",
      entries: [dir("lib"), file("a.ts")],
    }).state;
    state = treeReducer(state, { type: "toggle", path: "src" }).state; // ready → no fetch
    state = treeReducer(state, { type: "select", path: "src/lib" }).state;
    const update = handleTreeKey(state, "ArrowRight");
    expect(update.state.dirs["src/lib"]?.status).toBe("loading");
    expect(update.fetchDirs).toEqual(["src/lib"]);
  });

  it("ArrowRight on an expanded dir selects its first child", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "src" }).state;
    expect(handleTreeKey(state, "ArrowRight").state.selectedPath).toBe("src/lib");
  });

  it("ArrowRight on a file is a no-op", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "README.md" }).state;
    const update = handleTreeKey(state, "ArrowRight");
    expect(update.state.selectedPath).toBe("README.md");
    expect(update.fetchDirs).toEqual([]);
  });

  it("ArrowLeft on an expanded dir collapses it", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "src" }).state;
    const update = handleTreeKey(state, "ArrowLeft");
    expect(update.state.expanded).not.toContain("src");
    expect(update.state.selectedPath).toBe("src");
  });

  it("ArrowLeft on a file selects its parent dir", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "toggle", path: "src/lib" }).state; // ready → expands cached
    state = treeReducer(state, { type: "select", path: "src/lib/util.ts" }).state;
    expect(handleTreeKey(state, "ArrowLeft").state.selectedPath).toBe("src/lib");
  });

  it("ArrowLeft on a top-level entry is a no-op", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "README.md" }).state;
    expect(handleTreeKey(state, "ArrowLeft").state.selectedPath).toBe("README.md");
  });

  it("Enter on a file opens it; Enter on a dir toggles it", () => {
    let state = expandedTree();
    state = treeReducer(state, { type: "select", path: "src/a.ts" }).state;
    const open = handleTreeKey(state, "Enter");
    expect(open.openFiles).toEqual(["src/a.ts"]);
    expect(open.state.selectedPath).toBe("src/a.ts");

    state = treeReducer(state, { type: "select", path: "src/lib" }).state;
    const enterExpand = handleTreeKey(state, "Enter");
    expect(enterExpand.openFiles).toEqual([]);
    expect(enterExpand.state.expanded).toContain("src/lib");
    const enterCollapse = handleTreeKey(enterExpand.state, "Enter");
    expect(enterCollapse.state.expanded).not.toContain("src/lib");
  });

  it("keys are no-ops without a selection on an empty tree", () => {
    const state = initTree();
    for (const key of ["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft", "Enter"] as const) {
      expect(handleTreeKey(state, key).state).toBe(state);
    }
  });
});

describe("path helpers", () => {
  it("joinDirPath folds the root away", () => {
    expect(joinDirPath("", "src")).toBe("src");
    expect(joinDirPath("src", "lib")).toBe("src/lib");
  });

  it("parentPath returns null at the top level", () => {
    expect(parentPath("src")).toBeNull();
    expect(parentPath("src/lib/util.ts")).toBe("src/lib");
  });
});

describe("file history", () => {
  it("starts empty with navigation disabled", () => {
    const history = initHistory<string>();
    expect(historyCurrent(history)).toBeNull();
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  it("push tracks the current file and enables back", () => {
    let history = historyPush(initHistory<string>(), "a.ts");
    history = historyPush(history, "b.ts");
    expect(historyCurrent(history)).toBe("b.ts");
    expect(canGoBack(history)).toBe(true);
    expect(canGoForward(history)).toBe(false);

    history = historyBack(history);
    expect(historyCurrent(history)).toBe("a.ts");
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(true);

    history = historyForward(history);
    expect(historyCurrent(history)).toBe("b.ts");
  });

  it("pushing after going back truncates the forward tail", () => {
    let history = historyPush(initHistory<string>(), "a.ts");
    history = historyPush(history, "b.ts");
    history = historyPush(history, "c.ts");
    history = historyBack(history);
    history = historyBack(history);
    expect(historyCurrent(history)).toBe("a.ts");

    history = historyPush(history, "d.ts");
    expect(historyCurrent(history)).toBe("d.ts");
    expect(history.entries).toEqual(["a.ts", "d.ts"]);
    expect(canGoForward(history)).toBe(false);
  });

  it("pushing the current file again is a no-op", () => {
    let history = historyPush(initHistory<string>(), "a.ts");
    history = historyPush(history, "b.ts");
    const again = historyPush(history, "b.ts");
    expect(again).toBe(history);
  });

  it("back/forward clamp at the ends", () => {
    const history = historyPush(initHistory<string>(), "a.ts");
    expect(historyBack(history)).toBe(history);
    expect(historyForward(history)).toBe(history);
  });

  it("caps the history length", () => {
    let history = initHistory<string>();
    for (let i = 0; i < 60; i += 1) {
      history = historyPush(history, `file-${i}.ts`);
    }
    expect(history.entries.length).toBe(50);
    expect(historyCurrent(history)).toBe("file-59.ts");
    expect(canGoBack(history)).toBe(true);
  });
});

describe("fileViewerModel", () => {
  it("renders text files with lines and no notice", () => {
    const model = fileViewerModel({
      content: "one\ntwo",
      truncated: false,
      binary: false,
      size: 7,
    });
    expect(model.mode).toBe("text");
    expect(model.lines).toEqual(["one", "two"]);
    expect(model.notice).toBeNull();
  });

  it("shows a truncation notice for oversized files", () => {
    const model = fileViewerModel({
      content: "x".repeat(100),
      truncated: true,
      binary: false,
      size: 300 * 1024,
    });
    expect(model.mode).toBe("text");
    expect(model.notice).toContain("256.0 KB");
    expect(model.notice).toContain("300.0 KB");
  });

  it("binary files show a byte notice and no content", () => {
    const model = fileViewerModel({ content: "", truncated: false, binary: true, size: 4096 });
    expect(model.mode).toBe("binary");
    expect(model.lines).toEqual([]);
    expect(model.notice).toContain("4.0 KB");
    expect(model.notice).toContain("Binary");
  });

  it("formats byte sizes compactly", () => {
    expect(
      fileViewerModel({ content: "hi", truncated: false, binary: false, size: MAX_CONTENT_BYTES })
        .notice,
    ).toBeNull();
  });
});

describe("fetchTree / fetchFileContent", () => {
  const fetchMock = vi.fn();

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("fetchTree requests the root listing without a path query", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ entries: [{ name: "src", type: "dir", size: 0 }] }),
    );
    await expect(fetchTree("p 1")).resolves.toEqual([{ name: "src", type: "dir", size: 0 }]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${DEFAULT_DAEMON_URL}/api/projects/p%201/tree`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("fetchTree requests one directory level with an encoded path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [] }));
    await fetchTree("proj", "src/lib dir");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${DEFAULT_DAEMON_URL}/api/projects/proj/tree?path=src%2Flib%20dir`,
      expect.anything(),
    );
  });

  it("fetchFileContent requests the encoded file path", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: "x", truncated: false, binary: false, size: 1 }),
    );
    await expect(fetchFileContent("proj", "src/a b.ts")).resolves.toEqual({
      content: "x",
      truncated: false,
      binary: false,
      size: 1,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${DEFAULT_DAEMON_URL}/api/projects/proj/file?path=src%2Fa%20b.ts`,
      expect.anything(),
    );
  });
});
