"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileContent } from "@openeuler/core";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { fetchFileContent, fileViewerModel, formatBytes } from "@/lib/workspace";

type ViewerLoad =
  | { phase: "idle" }
  | { phase: "loading"; path: string }
  | { phase: "ready"; path: string; file: FileContent }
  | { phase: "error"; path: string; message: string };

function NavArrow({
  direction,
  disabled,
  label,
  onClick,
}: {
  direction: "back" | "forward";
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="secondary"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="px-2 py-1"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className={`size-4 ${direction === "back" ? "rotate-90" : "-rotate-90"}`}
        fill="currentColor"
      >
        <path d="M6 4l4 4-4 4z" />
      </svg>
    </Button>
  );
}

/**
 * Right-pane file viewer: mono content with line numbers, truncated/binary
 * notices from the daemon payload, and in-session back/forward navigation
 * (the history stack itself lives in the workspace view).
 */
export function FileViewer({
  projectId,
  path,
  canBack,
  canForward,
  onBack,
  onForward,
}: {
  projectId: string;
  path: string | null;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const [load, setLoad] = useState<ViewerLoad>({ phase: "idle" });
  const requestSeq = useRef(0);

  const loadFile = useCallback(async () => {
    if (path === null) {
      requestSeq.current += 1;
      setLoad({ phase: "idle" });
      return;
    }
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoad({ phase: "loading", path });
    try {
      const file = await fetchFileContent(projectId, path);
      if (requestSeq.current !== seq) return;
      setLoad({ phase: "ready", path, file });
    } catch (error) {
      if (requestSeq.current !== seq) return;
      setLoad({
        phase: "error",
        path,
        message: error instanceof ApiError ? error.message : "Failed to load file",
      });
    }
  }, [path, projectId]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-surface shadow-1">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <NavArrow direction="back" disabled={!canBack} label="Previous file" onClick={onBack} />
        <NavArrow
          direction="forward"
          disabled={!canForward}
          label="Next file"
          onClick={onForward}
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm text-fg"
          title={path ?? undefined}
        >
          {path ?? "No file selected"}
        </span>
        {load.phase === "ready" ? (
          <span className="shrink-0 text-xs text-muted-fg">{formatBytes(load.file.size)}</span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {load.phase === "idle" ? (
          <p className="p-6 text-sm text-muted-fg">
            Select a file in the tree to view its contents.
          </p>
        ) : load.phase === "loading" ? (
          <p className="p-6 text-sm text-muted-fg" role="status">
            Loading {load.path}…
          </p>
        ) : load.phase === "error" ? (
          <div className="flex flex-col items-start gap-3 p-6 text-sm">
            <p className="text-danger">{load.message}</p>
            <Button variant="secondary" onClick={() => void loadFile()}>
              Retry
            </Button>
          </div>
        ) : (
          <FileBody file={load.file} />
        )}
      </div>
    </section>
  );
}

function FileBody({ file }: { file: FileContent }) {
  const model = fileViewerModel(file);
  return (
    <div className="flex flex-col">
      {model.notice ? (
        <p
          role="note"
          className="border-b border-warning/40 bg-warning-subtle px-3 py-1.5 text-xs text-warning"
        >
          {model.notice}
        </p>
      ) : null}
      {model.mode === "binary" ? (
        <p className="p-6 text-sm text-muted-fg">Nothing to show for a binary file.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {model.lines.map((line, index) => (
              <tr key={index} className="hover:bg-elevated/60">
                <td className="w-12 select-none border-r border-border pr-2 text-right align-top text-muted-fg">
                  {index + 1}
                </td>
                <td className="whitespace-pre px-3 align-top text-fg">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
