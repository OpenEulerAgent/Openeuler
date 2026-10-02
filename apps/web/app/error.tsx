"use client";

import { CrashCard } from "@/components/error/CrashCard";

/**
 * Root error boundary (#96): catches every render error below the root
 * layout that a nearer segment boundary does not, so any route can degrade
 * to the crash card instead of a white screen. 404s never land here — they
 * are responses, not exceptions; not-found handling stays with the pages
 * (e.g. RunDetailView's 404 phase) or Next's default not-found.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashCard error={error} reset={reset} />;
}
