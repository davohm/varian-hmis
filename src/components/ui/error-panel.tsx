"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "cn";

export interface ErrorPanelProps extends React.HTMLAttributes<HTMLElement> {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  description?: string;
}

/**
 * Clinical-operations error UI shared by the root route error boundary and the
 * root global-error boundary. Retry is always available; the support reference
 * is shown only when the runtime actually supplied an error digest — no status
 * or reference value is invented here.
 */
export function ErrorPanel({
  error,
  reset,
  title = "This screen could not be loaded",
  description = "Retry to continue. If your connection is offline or sync is paused, wait until it is available and try again. Do not resubmit a record you may already have saved.",
  className,
  ...props
}: ErrorPanelProps) {
  const retryRef = React.useRef<HTMLButtonElement>(null);
  const rawDigest = error?.digest;
  const reference =
    typeof rawDigest === "string" && rawDigest.trim() ? rawDigest.trim() : null;

  React.useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return (
    <section
      data-slot="error-panel"
      role="alert"
      aria-label={title}
      className={cn(
        "rounded-lg border border-border bg-card p-6 shadow-sm",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-4">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
          aria-hidden="true"
        >
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-primary">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </p>

          <div className="mt-5 rounded-md border border-border bg-muted/50 p-3">
            <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
              Support reference
            </p>
            <p className="mt-1 text-sm">
              {reference ? (
                <code className="break-all font-mono text-xs text-foreground">
                  {reference}
                </code>
              ) : (
                <span className="text-muted-foreground">
                  Not supplied with this error
                </span>
              )}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Quote this reference to support when reporting the problem. No
              connection or sync status is implied.
            </p>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              ref={retryRef}
              type="button"
              onClick={reset}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
