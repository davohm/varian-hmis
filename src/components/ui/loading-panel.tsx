import * as React from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export interface LoadingPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Announced to assistive technology. Keep it short, e.g. "Loading". */
  label?: string;
  /** Optional visible context above the skeleton bars. */
  title?: string;
  rows?: number;
}

const SKELETON_WIDTHS = ["w-full", "w-[92%]", "w-4/5", "w-full", "w-2/3"] as const;

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
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        className,
      )}
      {...props}
    >
      <span className="sr-only">{label}</span>
      <div className="border-b border-border/80 px-5 py-4">
        {title ? (
          <p className="text-sm font-medium text-foreground">{title}</p>
        ) : (
          <Skeleton className="h-4 w-36" />
        )}
        <Skeleton className="mt-2 h-3 w-56 max-w-full" />
      </div>
      <div aria-hidden="true" className="space-y-3 px-5 py-5">
        {Array.from({ length: rowCount }, (_, index) => (
          <Skeleton
            key={index}
            className={cn("h-3", SKELETON_WIDTHS[index % SKELETON_WIDTHS.length])}
          />
        ))}
      </div>
    </div>
  );
}
