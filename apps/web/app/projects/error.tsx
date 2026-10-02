"use client";

import { CrashCard } from "@/components/error/CrashCard";

/** /projects segment boundary (#96): covers workspace + workflow subroutes. */
export default function ProjectsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashCard error={error} reset={reset} />;
}
