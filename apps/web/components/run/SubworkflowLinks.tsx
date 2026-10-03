import Link from "next/link";

/**
 * Sub-workflow lineage strip (#117): rendered on the run detail page when a
 * run is part of a parent↔child chain — a "child of …" link up to the
 * parent run, and one link per spawned child run ("N child runs"). Server
 * component by design: the ids come straight off the run detail payload.
 */
export function SubworkflowLinks({
  runId,
  parentRunId,
  childRunIds,
}: {
  runId: string;
  parentRunId?: string | undefined;
  childRunIds?: readonly string[] | undefined;
}) {
  if (parentRunId === undefined && (childRunIds?.length ?? 0) === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border bg-elevated/40 px-3 py-2 text-xs"
      data-subworkflow-links
      data-run-id={runId}
    >
      {parentRunId !== undefined ? (
        <span className="flex items-center gap-1.5 text-muted-fg">
          <span aria-hidden className="text-[10px] tracking-wide uppercase">
            child of
          </span>
          <Link
            href={`/runs/${parentRunId}`}
            data-parent-run-link={parentRunId}
            className="rounded font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            run {parentRunId.slice(0, 8)}
          </Link>
        </span>
      ) : null}
      {(childRunIds?.length ?? 0) > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5 text-muted-fg">
          <span aria-hidden className="text-[10px] tracking-wide uppercase">
            {(childRunIds as string[]).length === 1
              ? "1 child run"
              : `${childRunIds?.length} child runs`}
          </span>
          {(childRunIds ?? []).map((childRunId) => (
            <Link
              key={childRunId}
              href={`/runs/${childRunId}`}
              data-child-run-link={childRunId}
              className="rounded font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {childRunId.slice(0, 8)}
            </Link>
          ))}
        </span>
      ) : null}
    </div>
  );
}
