import type { Metadata } from "next";
import { LanesView } from "@/components/lanes/LanesView";

export const metadata: Metadata = { title: "Lanes" };

export default function LanesPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-display font-semibold text-fg">Lanes</h1>
        <p className="mt-1 text-sm text-muted-fg">
          Parallel runs at a glance — live columns per active run, and a filmstrip of recent
          finishes.
        </p>
      </div>
      <LanesView />
    </div>
  );
}
