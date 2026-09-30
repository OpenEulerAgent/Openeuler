import { Card } from "@/components/Card";

/**
 * Unified diff from the run's step runs, as plain text. A styled/side-by-side
 * viewer lands with #20.
 */
export function DiffPanel({ diff }: { diff: string }) {
  return (
    <Card title="Diff" description="Changes made by this run (unified).">
      <pre className="max-h-[32rem] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800">
        {diff}
      </pre>
    </Card>
  );
}
