"use client";

import dynamic from "next/dynamic";
import { SkeletonLines } from "@/components/ui/skeleton";

// React Flow is client-only and heavy — keep it out of the server bundle and
// the first-load JS of every other page (the route code-splits here).
const CanvasEditorView = dynamic(
  () => import("./CanvasEditorView").then((mod) => mod.CanvasEditorView),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-[calc(100dvh-4rem)] items-center justify-center p-6"
        data-canvas-loading
      >
        <div className="w-full max-w-xl">
          <SkeletonLines rows={4} />
        </div>
      </div>
    ),
  },
);

/** Client wrapper so the (server) edit route can defer-load the canvas. */
export function CanvasEditorLoader(props: { projectId: string; workflowId: string }) {
  return <CanvasEditorView {...props} />;
}
