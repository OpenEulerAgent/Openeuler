"use client";

import { CrashCard } from "@/components/error/CrashCard";

/** /welcome segment boundary (#96): the onboarding wizard gets the card too. */
export default function WelcomeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashCard error={error} reset={reset} />;
}
