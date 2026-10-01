"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsed } from "@/lib/run-feed";
import type { RunGraphFoldState, TimelineFoldEntry } from "@/lib/run-graph/fold";

function KindBadge({ kind }: { kind: TimelineFoldEntry["kind"] }) {
  if (kind === "node") return <Badge variant="info">node</Badge>;
  if (kind === "edge") return <Badge variant="neutral">edge</Badge>;
  return <Badge variant="warning">cap</Badge>;
}

/**
 * Timeline tab (#52): the execution breadcrumb as a flat table — one row per
 * completed node execution and taken edge (plus cycle-guard warnings), with
 * per-node iteration and duration. Built from the same fold as the graph,
 * so it is refresh-safe by construction.
 */
export function TimelineTab({ state }: { state: RunGraphFoldState }) {
  const entries = state.timeline;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            Execution order: completed node executions, taken edges and guard warnings.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="py-4 text-sm text-muted-fg">
            Nothing has executed yet — rows appear as the run progresses.
          </p>
        ) : (
          <div className="max-h-[32rem] overflow-y-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="sticky top-0 border-b border-border bg-surface text-xs text-muted-fg">
                  <th scope="col" className="px-3 py-2 font-medium">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Kind
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Iteration
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Duration
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody data-timeline-rows>
                {entries.map((entry, index) => (
                  <tr
                    key={`${entry.seq}-${entry.kind}-${index}`}
                    className="border-b border-border/60 align-top"
                    data-timeline-kind={entry.kind}
                  >
                    <td className="px-3 py-2 text-xs tabular-nums text-muted-fg">
                      {entry.kind === "cap" ? "" : entry.position + 1}
                    </td>
                    <td className="px-3 py-2">
                      <KindBadge kind={entry.kind} />
                    </td>
                    <td className="max-w-64 px-3 py-2">
                      <span className="block truncate font-mono text-xs" title={entry.name}>
                        {entry.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums">
                      {entry.kind === "cap" ? "—" : entry.iteration}
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums">
                      {entry.durationMs === undefined ? "—" : formatElapsed(0, entry.durationMs)}
                    </td>
                    <td className="max-w-72 px-3 py-2">
                      {entry.status ? (
                        <span className="mr-2 text-xs font-medium">{entry.status}</span>
                      ) : null}
                      {entry.detail ? (
                        <span className="block truncate text-xs text-muted-fg" title={entry.detail}>
                          {entry.detail}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
