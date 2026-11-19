"use client";

import { ErrorPanel } from "@/components/ui/error-panel";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-lg">
        <p className="mb-4 font-mono text-[10px] tracking-[0.18em] text-primary uppercase">
          Varian HMIS · Clinical operations
        </p>
        <ErrorPanel error={error} reset={reset} />
      </div>
    </main>
  );
}
