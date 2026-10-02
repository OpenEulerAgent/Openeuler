"use client";

import { CrashCard } from "@/components/error/CrashCard";

/** /runs segment boundary (#96): crash card for the list and detail routes. */
export default function RunsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashCard error={error} reset={reset} />;
}
