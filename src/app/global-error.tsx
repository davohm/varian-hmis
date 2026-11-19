"use client";

import "./globals.css";

import { ErrorPanel } from "@/components/ui/error-panel";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        className="bg-background text-foreground antialiased"
        style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}
      >
        <main className="grid min-h-screen place-items-center p-6">
          <div className="w-full max-w-lg">
            <p className="mb-4 font-mono text-[10px] tracking-[0.18em] text-primary uppercase">
              Varian HMIS · Clinical operations
            </p>
            <ErrorPanel error={error} reset={reset} />
          </div>
        </main>
      </body>
    </html>
  );
}
