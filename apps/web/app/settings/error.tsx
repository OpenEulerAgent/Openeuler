"use client";

import { CrashCard } from "@/components/error/CrashCard";

/** /settings segment boundary (#96). */
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashCard error={error} reset={reset} />;
}
