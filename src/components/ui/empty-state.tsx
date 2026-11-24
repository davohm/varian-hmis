import * as React from "react";
import { Inbox, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
  headingLevel?: 1 | 2 | 3 | 4;
}

/**
 * A calm, text-led panel for "nothing to show" moments (empty queues, no search
 * matches, no results yet). Meaning is carried by the heading and description,
 * never by colour; the icon is decorative.
 */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
  headingLevel = 2,
  className,
  children,
  ...props
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3" | "h4";

  return (
    <section
      data-slot="empty-state"
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/60 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      <span
        className="grid size-11 place-items-center rounded-xl bg-secondary text-primary ring-1 ring-border/60"
        aria-hidden="true"
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <Heading className="mt-4 text-sm font-semibold text-foreground">{title}</Heading>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {children}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </section>
  );
}
