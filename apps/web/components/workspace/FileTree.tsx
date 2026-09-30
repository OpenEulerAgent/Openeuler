"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  fetchTree,
  flattenVisibleTree,
  initTree,
  ROOT_DIR,
  treeReducer,
  type TreeAction,
  type TreeKey,
  type TreeState,
  type TreeDirState,
  type VisibleTreeNode,
} from "@/lib/workspace";

const TREE_KEYS: readonly TreeKey[] = ["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft", "Enter"];

function isTreeKey(key: string): key is TreeKey {
  return (TREE_KEYS as readonly string[]).includes(key);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0 text-slate-400 transition-transform", open && "rotate-90")}
      fill="currentColor"
    >
      <path d="M6 4l4 4-4 4z" />
    </svg>
  );
}

function DirIcon({ open }: { open: boolean }) {
  return open ? (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-slate-500"
      fill="currentColor"
    >
      <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.086a1.5 1.5 0 0 1 1.06.44l.915.914a.5.5 0 0 0 .353.146H13A1.5 1.5 0 0 1 14.5 4.5V6H1.5z" />
      <path d="M1.5 7h13v5A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z" />
    </svg>
  ) : (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-slate-500"
      fill="currentColor"
    >
      <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.086a1.5 1.5 0 0 1 1.06.44l.915.914a.5.5 0 0 0 .353.146H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-slate-400"
      fill="currentColor"
    >
      <path d="M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.914a1.5 1.5 0 0 0-.44-1.06l-2.914-2.915a1.5 1.5 0 0 0-1.06-.439zm6 1.121L12.379 5H10z" />
    </svg>
  );
}

const IDLE_DIR: TreeDirState = { status: "idle", entries: [], error: null };

/**
 * Lazy one-level-at-a-time file tree. All tree transitions flow through the
 * pure {@link treeReducer}; the component only wires fetch/open effects and
 * renders the flattened visible rows.
 */
export function FileTree({
  projectId,
  onOpenFile,
}: {
  projectId: string;
  onOpenFile: (path: string) => void;
}) {
  const [state, setState] = useState<TreeState>(initTree);
  const stateRef = useRef(state);
  const inFlight = useRef<Set<string>>(new Set());
  const generation = useRef(0);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const commit = useCallback((next: TreeState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const loadDir = useCallback(
    async (dir: string) => {
      if (inFlight.current.has(dir)) return;
      inFlight.current.add(dir);
      const gen = generation.current;
      try {
        const entries = await fetchTree(projectId, dir);
        if (gen !== generation.current) return;
        commit(treeReducer(stateRef.current, { type: "dir-loaded", path: dir, entries }).state);
      } catch (error) {
        if (gen !== generation.current) return;
        commit(
          treeReducer(stateRef.current, {
            type: "dir-error",
            path: dir,
            message: errorMessage(error, "Failed to load directory"),
          }).state,
        );
      } finally {
        inFlight.current.delete(dir);
      }
    },
    [commit, projectId],
  );

  const apply = useCallback(
    (action: TreeAction) => {
      const update = treeReducer(stateRef.current, action);
      commit(update.state);
      for (const dir of update.fetchDirs) void loadDir(dir);
      for (const file of update.openFiles) onOpenFileRef.current(file);
    },
    [commit, loadDir],
  );

  // Load the root listing once per project; stale fetches are dropped.
  useEffect(() => {
    generation.current += 1;
    inFlight.current.clear();
    commit(initTree());
    apply({ type: "toggle", path: ROOT_DIR });
  }, [apply, commit, projectId]);

  // Keep the selected row in view during keyboard navigation.
  const selectedPath = state.selectedPath;
  useEffect(() => {
    if (selectedPath === null) return;
    rowRefs.current.get(selectedPath)?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  const root = state.dirs[ROOT_DIR] ?? IDLE_DIR;
  const visible = flattenVisibleTree(state);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isTreeKey(event.key)) return;
    event.preventDefault();
    apply({ type: "key", key: event.key });
  };

  return (
    <div
      role="tree"
      aria-label="Project files"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="h-full overflow-auto rounded-xl border border-slate-200 bg-white p-2 font-mono text-sm text-slate-700 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
    >
      {root.status === "idle" || root.status === "loading" ? (
        <p className="px-2 py-4 text-sm text-slate-400" role="status">
          Loading files…
        </p>
      ) : root.status === "error" ? (
        <div className="flex flex-col items-start gap-2 px-2 py-4 text-sm">
          <p className="text-red-600">{root.error}</p>
          <button
            type="button"
            onClick={() => apply({ type: "retry", path: ROOT_DIR })}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            Retry
          </button>
        </div>
      ) : root.entries.length === 0 ? (
        <p className="px-2 py-4 text-sm text-slate-400">
          This repository is empty — no files to browse.
        </p>
      ) : (
        visible.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            childListing={node.expanded ? (state.dirs[node.path] ?? IDLE_DIR) : null}
            selected={state.selectedPath === node.path}
            onClick={() => {
              if (node.type === "dir") {
                apply({ type: "select", path: node.path });
                apply({ type: "toggle", path: node.path });
              } else {
                apply({ type: "open", path: node.path });
              }
            }}
            onRetry={() => apply({ type: "retry", path: node.path })}
            registerRef={(el) => {
              if (el === null) rowRefs.current.delete(node.path);
              else rowRefs.current.set(node.path, el);
            }}
          />
        ))
      )}
    </div>
  );
}

function TreeRow({
  node,
  childListing,
  selected,
  onClick,
  onRetry,
  registerRef,
}: {
  node: VisibleTreeNode;
  childListing: TreeDirState | null;
  selected: boolean;
  onClick: () => void;
  onRetry: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const childIndent = `${(node.depth + 1) * 14 + 22}px`;
  return (
    <>
      <div
        ref={registerRef}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-selected={selected}
        aria-expanded={node.type === "dir" ? node.expanded : undefined}
        title={node.path}
        onClick={onClick}
        className={cn(
          "flex cursor-pointer select-none items-center gap-1 rounded-md px-1 py-1",
          selected ? "bg-slate-900 text-white" : "hover:bg-slate-100",
        )}
        style={{ paddingLeft: `${node.depth * 14 + 4}px` }}
      >
        {node.type === "dir" ? (
          <Chevron open={node.expanded} />
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        {node.type === "dir" ? <DirIcon open={node.expanded} /> : <FileIcon />}
        <span className="truncate">{node.name}</span>
      </div>
      {node.type === "dir" && childListing?.status === "loading" ? (
        <div
          aria-hidden
          className="py-1 text-xs text-slate-400"
          style={{ paddingLeft: childIndent }}
        >
          Loading…
        </div>
      ) : null}
      {node.type === "dir" && childListing?.status === "error" ? (
        <div className="flex items-center gap-2 py-1 text-xs" style={{ paddingLeft: childIndent }}>
          <span className="truncate text-red-600" title={childListing.error ?? undefined}>
            {childListing.error}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 font-sans text-slate-600 hover:bg-slate-100"
          >
            Retry
          </button>
        </div>
      ) : null}
      {node.type === "dir" &&
      childListing?.status === "ready" &&
      childListing.entries.length === 0 ? (
        <div
          aria-hidden
          className="py-1 text-xs text-slate-400"
          style={{ paddingLeft: childIndent }}
        >
          (empty)
        </div>
      ) : null}
    </>
  );
}
