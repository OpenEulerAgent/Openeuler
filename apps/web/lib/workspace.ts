import type { FileContent, FileNode, FileType } from "@openeuler/core";
import { apiFetch } from "./api";

/** Content cap enforced by the daemon file API (mirrored for viewer notices). */
export const MAX_CONTENT_BYTES = 256 * 1024;

/** Relative path of the repository root inside the tree state. */
export const ROOT_DIR = "";

/** Load status of one directory's children (the root included). */
export type TreeDirStatus = "idle" | "loading" | "ready" | "error";

export interface TreeDirState {
  status: TreeDirStatus;
  /** Children as last fetched; empty until `ready`. Dirs first, as sorted by the API. */
  entries: FileNode[];
  /** Failure message when `status === "error"`. */
  error: string | null;
}

export interface TreeState {
  /** Per-directory load state keyed by relative path (`""` is the root). */
  dirs: Record<string, TreeDirState>;
  /** Relative paths of expanded directories. */
  expanded: string[];
  /** Relative path of the selected row, if any. */
  selectedPath: string | null;
}

/** What a reducer transition wants the caller to do besides storing the state. */
export interface TreeUpdate {
  state: TreeState;
  /** Directories whose children must be fetched now (lazy expansion). */
  fetchDirs: string[];
  /** Files to open (Enter key on a file row). */
  openFiles: string[];
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "ArrowRight" | "ArrowLeft" | "Enter";

export type TreeAction =
  | { type: "select"; path: string }
  | { type: "open"; path: string }
  | { type: "toggle"; path: string }
  | { type: "retry"; path: string }
  | { type: "dir-loaded"; path: string; entries: FileNode[] }
  | { type: "dir-error"; path: string; message: string }
  | { type: "key"; key: TreeKey };

/** One flattened, renderable tree row (only expanded+loaded dirs recurse). */
export interface VisibleTreeNode {
  path: string;
  name: string;
  type: FileType;
  size: number;
  depth: number;
  expanded: boolean;
  status: TreeDirStatus;
}

export function initTree(): TreeState {
  return {
    dirs: { [ROOT_DIR]: { status: "idle", entries: [], error: null } },
    expanded: [],
    selectedPath: null,
  };
}

/** Join a child name onto a relative dir path (`""` root folds away). */
export function joinDirPath(dir: string, name: string): string {
  return dir === ROOT_DIR ? name : `${dir}/${name}`;
}

/** Parent directory path, or `null` for top-level entries. */
export function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

function isExpanded(state: TreeState, path: string): boolean {
  return state.expanded.includes(path);
}

function dirState(state: TreeState, path: string): TreeDirState {
  return state.dirs[path] ?? { status: "idle", entries: [], error: null };
}

/**
 * Depth-first walk of the tree, emitting only rows the user can see: children
 * of a directory appear (in API order, dirs first) only when it is expanded
 * and its listing has loaded.
 */
export function flattenVisibleTree(state: TreeState): VisibleTreeNode[] {
  const nodes: VisibleTreeNode[] = [];
  const walk = (dir: string, depth: number): void => {
    const listing = dirState(state, dir);
    if (listing.status !== "ready") return;
    for (const entry of listing.entries) {
      const path = joinDirPath(dir, entry.name);
      const expanded = entry.type === "dir" && isExpanded(state, path);
      nodes.push({
        path,
        name: entry.name,
        type: entry.type,
        size: entry.size,
        depth,
        expanded,
        status: dirState(state, path).status,
      });
      if (expanded) walk(path, depth + 1);
    }
  };
  walk(ROOT_DIR, 0);
  return nodes;
}

function unchanged(state: TreeState): TreeUpdate {
  return { state, fetchDirs: [], openFiles: [] };
}

function withState(state: TreeState): TreeUpdate {
  return { state, fetchDirs: [], openFiles: [] };
}

/** Expand a directory, requesting its children only when not cached yet. */
function expandDir(state: TreeState, path: string): TreeUpdate {
  if (isExpanded(state, path) || dirState(state, path).status === "loading") {
    return unchanged(state);
  }
  if (dirState(state, path).status === "ready") {
    return withState({ ...state, expanded: [...state.expanded, path] });
  }
  // idle or error → (re)load its children.
  const next: TreeState = {
    ...state,
    dirs: { ...state.dirs, [path]: { status: "loading", entries: [], error: null } },
    expanded: [...state.expanded, path],
  };
  return { state: next, fetchDirs: [path], openFiles: [] };
}

/** Collapse an expanded directory (children stay cached for re-expansion). */
function collapseDir(state: TreeState, path: string): TreeUpdate {
  if (!isExpanded(state, path)) return unchanged(state);
  return withState({ ...state, expanded: state.expanded.filter((p) => p !== path) });
}

function toggleDir(state: TreeState, path: string): TreeUpdate {
  return isExpanded(state, path) ? collapseDir(state, path) : expandDir(state, path);
}

/**
 * Keyboard navigation over the flattened tree, VSCode-style:
 * Up/Down move the selection, Right expands (or dives into) a directory,
 * Left collapses (or selects the parent), Enter opens a file / toggles a dir.
 */
export function handleTreeKey(state: TreeState, key: TreeKey): TreeUpdate {
  const visible = flattenVisibleTree(state);
  const selectedIndex =
    state.selectedPath === null
      ? -1
      : visible.findIndex((node) => node.path === state.selectedPath);
  const selected = selectedIndex >= 0 ? (visible[selectedIndex] ?? null) : null;

  switch (key) {
    case "ArrowDown": {
      if (visible.length === 0) return unchanged(state);
      const next = Math.min(selectedIndex + 1, visible.length - 1);
      return withState({ ...state, selectedPath: (visible[next] ?? visible[0]!).path });
    }
    case "ArrowUp": {
      if (visible.length === 0) return unchanged(state);
      const prev = Math.max(selectedIndex - 1, 0);
      return withState({ ...state, selectedPath: (visible[prev] ?? visible[0]!).path });
    }
    case "ArrowRight": {
      if (!selected || selected.type !== "dir") return unchanged(state);
      if (selected.expanded) {
        const listing = dirState(state, selected.path);
        const first = listing.status === "ready" ? listing.entries[0] : undefined;
        if (!first) return unchanged(state);
        return withState({ ...state, selectedPath: joinDirPath(selected.path, first.name) });
      }
      return expandDir(state, selected.path);
    }
    case "ArrowLeft": {
      if (!selected) return unchanged(state);
      if (selected.type === "dir" && selected.expanded) {
        return collapseDir(state, selected.path);
      }
      const parent = parentPath(selected.path);
      return parent === null ? unchanged(state) : withState({ ...state, selectedPath: parent });
    }
    case "Enter": {
      if (!selected) return unchanged(state);
      if (selected.type === "file") {
        return {
          state: { ...state, selectedPath: selected.path },
          fetchDirs: [],
          openFiles: [selected.path],
        };
      }
      return toggleDir(state, selected.path);
    }
  }
}

/** Pure transition function for the file tree (no I/O — see fetchTree). */
export function treeReducer(state: TreeState, action: TreeAction): TreeUpdate {
  switch (action.type) {
    case "select":
      return withState({ ...state, selectedPath: action.path });
    case "open":
      return {
        state: { ...state, selectedPath: action.path },
        fetchDirs: [],
        openFiles: [action.path],
      };
    case "toggle":
      return toggleDir(state, action.path);
    case "retry": {
      if (dirState(state, action.path).status !== "error") return unchanged(state);
      const next: TreeState = {
        ...state,
        dirs: { ...state.dirs, [action.path]: { status: "loading", entries: [], error: null } },
      };
      return { state: next, fetchDirs: [action.path], openFiles: [] };
    }
    case "dir-loaded":
      return withState({
        ...state,
        dirs: {
          ...state.dirs,
          [action.path]: { status: "ready", entries: action.entries, error: null },
        },
      });
    case "dir-error":
      return withState({
        ...state,
        dirs: {
          ...state.dirs,
          [action.path]: { status: "error", entries: [], error: action.message },
        },
      });
    case "key":
      return handleTreeKey(state, action.key);
  }
}

/** In-session navigation history for recently opened files (back/forward). */
export interface HistoryState<T> {
  entries: T[];
  index: number;
}

export const HISTORY_CAP = 50;

export function initHistory<T>(): HistoryState<T> {
  return { entries: [], index: -1 };
}

export function historyCurrent<T>(history: HistoryState<T>): T | null {
  return history.index >= 0 ? (history.entries[history.index] ?? null) : null;
}

export function canGoBack<T>(history: HistoryState<T>): boolean {
  return history.index > 0;
}

export function canGoForward<T>(history: HistoryState<T>): boolean {
  return history.index < history.entries.length - 1;
}

/** Open a file: truncates any forward entries, then appends (capped). */
export function historyPush<T>(history: HistoryState<T>, item: T): HistoryState<T> {
  if (historyCurrent(history) === item) return history;
  const entries = [...history.entries.slice(0, history.index + 1), item];
  const overflow = Math.max(0, entries.length - HISTORY_CAP);
  const trimmed = entries.slice(overflow);
  return { entries: trimmed, index: trimmed.length - 1 };
}

export function historyBack<T>(history: HistoryState<T>): HistoryState<T> {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function historyForward<T>(history: HistoryState<T>): HistoryState<T> {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

/** What the file viewer should render for one fetched file. */
export interface FileViewerModel {
  mode: "text" | "binary";
  lines: string[];
  /** Truncation / binary notice shown above the content; `null` when clean. */
  notice: string | null;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Display decision for a file payload: binary handling, truncation notice, lines. */
export function fileViewerModel(file: FileContent): FileViewerModel {
  if (file.binary) {
    return {
      mode: "binary",
      lines: [],
      notice: `Binary file (${formatBytes(file.size)}) — contents not displayed`,
    };
  }
  const notice = file.truncated
    ? `Showing first ${formatBytes(MAX_CONTENT_BYTES)} of ${formatBytes(file.size)} file`
    : null;
  return { mode: "text", lines: file.content.split("\n"), notice };
}

/** Fetch one level of a project's file tree (`GET /api/projects/:id/tree`). */
export async function fetchTree(
  projectId: string,
  dirPath: string = ROOT_DIR,
): Promise<FileNode[]> {
  const query = dirPath === ROOT_DIR ? "" : `?path=${encodeURIComponent(dirPath)}`;
  const body = await apiFetch<{ entries: FileNode[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/tree${query}`,
  );
  return body.entries;
}

/** Fetch a file's content payload (`GET /api/projects/:id/file`). */
export async function fetchFileContent(projectId: string, filePath: string): Promise<FileContent> {
  return apiFetch<FileContent>(
    `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
  );
}
