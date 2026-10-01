import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Final run output (mono), shown once the run is done. */
export function OutputPanel({ output }: { output: string }) {
  return (
    <Card className="bg-bg">
      <CardHeader>
        <div>
          <CardTitle>Output</CardTitle>
          <CardDescription>Final step output.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-relaxed text-fg">
          {output}
        </pre>
      </CardContent>
    </Card>
  );
}
