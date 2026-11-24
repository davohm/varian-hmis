"use client";

import { ErrorPanel } from "@/components/ui/error-panel";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl py-8">
      <ErrorPanel error={error} reset={reset} />
    </div>
  );
}
