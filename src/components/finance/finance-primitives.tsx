import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const TABLE_CLASS =
  "w-full border-collapse text-left text-sm [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap";
export const TH_CLASS =
  "border-b border-border bg-muted/60 px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase";
export const TD_CLASS = "border-b border-border/70 px-3 py-2 align-middle text-foreground";
export const NUMERIC_CLASS = "text-right font-mono tabular-nums";

interface PanelProps {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function Panel({ title, description, action, children, className, testId }: PanelProps) {
  return (
    <section
      data-testid={testId}
      className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-sm", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  className?: string;
}

export function Field({ label, children, hint, error, className }: FieldProps) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/40";

interface StatusPillProps {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  children: ReactNode;
  className?: string;
}

const TONE_CLASSES: Record<NonNullable<StatusPillProps["tone"]>, string> = {
  neutral: "bg-muted text-foreground",
  success: "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  warning: "bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  danger: "bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  info: "bg-[var(--status-info-background)] text-[var(--status-info-foreground)]",
};

export function StatusPill({ tone = "neutral", children, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-muted-foreground">
        {message}
      </td>
    </tr>
  );
}

export function SubHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-2">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
