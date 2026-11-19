import * as React from "react";
import { cn } from "cn";

export interface LoadingPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Announced to assistive technology. Keep it short, e.g. "Loading". */
  label?: string;
  /** Optional visible context above the skeleton bars. */
  title?: string;
  rows?: number;
}

const SKELETON_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-full", "w-2/3"] as const;

/**
 * Accessible loading placeholder. The live region is announced once when it
 * appears; the skeleton bars are hidden from assistive technology and stop
 * animating entirely when the user prefers reduced motion.
 */
export function LoadingPanel({
  label = "Loading",
  title,
  rows = 3,
  className,
  ...props
}: LoadingPanelProps) {
  const rowCount = Math.max(1, Math.min(Math.trunc(rows), SKELETON_WIDTHS.length));

  return (
    <div
      data-slot="loading-panel"
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("rounded-lg border border-border bg-card p-6", className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {title ? (
        <p className="mb-4 text-sm font-medium text-primary">{title}</p>
      ) : null}
      <div aria-hidden="true" className="space-y-3">
        {Array.from({ length: rowCount }, (_, index) => (
          <div
            key={index}
            className={cn(
              "varian-skeleton h-3 rounded bg-muted motion-safe:animate-pulse motion-reduce:animate-none",
              SKELETON_WIDTHS[index],
            )}
          />
        ))}
      </div>
    </div>
  );
}
