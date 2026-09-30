import { Card } from "@/components/Card";

/** Final run output (mono), shown once the run is done. */
export function OutputPanel({ output }: { output: string }) {
  return (
    <Card title="Output" description="Final step output.">
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
        {output}
      </pre>
    </Card>
  );
}
