"use client";

import { AlertCircle, Clock3, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface QueueEntry {
  id: string;
  encounterId: string;
  patientId: string;
  mrn: string;
  firstName: string;
  lastName: string;
  encounterNo: string;
  department: string;
  priority: "red" | "yellow" | "green" | "normal";
  status: "waiting" | "called" | "in_service" | "done" | "cancelled";
  queuedAt: string;
}

const PRIORITY_META: Record<
  QueueEntry["priority"],
  { label: string; className: string; dot: string }
> = {
  red: {
    label: "Emergency",
    className:
      "border-[var(--status-critical)]/30 bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
    dot: "bg-[var(--status-critical)]",
  },
  yellow: {
    label: "Urgent",
    className:
      "border-[var(--status-warning)]/30 bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
    dot: "bg-[var(--status-warning)]",
  },
  green: {
    label: "Fast track",
    className:
      "border-[var(--status-normal)]/30 bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
    dot: "bg-[var(--status-normal)]",
  },
  normal: {
    label: "Normal",
    className: "border-border bg-secondary text-secondary-foreground",
    dot: "bg-muted-foreground/50",
  },
};

function waitTime(queuedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(queuedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function statusLabel(status: QueueEntry["status"]): string {
  return status.replace(/_/g, " ");
}

export function QueueTable({
  department = "Triage",
  testId = "live-queue",
  compact = false,
  title,
  action,
  limit,
  initialEntries,
}: {
  department?: string;
  testId?: string;
  compact?: boolean;
  title?: string;
  action?: ReactNode;
  limit?: number;
  /** Server-rendered first paint. When provided, the initial skeleton is skipped. */
  initialEntries?: QueueEntry[];
}) {
  const [entries, setEntries] = useState<QueueEntry[]>(initialEntries ?? []);
  const [loading, setLoading] = useState(initialEntries === undefined);
  // Clock starts after mount so server and client render the same "waiting"
  // text; the interval keeps elapsed times ticking without a re-fetch.
  const [now, setNow] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      try {
        const response = await fetch(`/api/queue?department=${encodeURIComponent(department)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`Could not load queue (${response.status})`);
        }
        const data = (await response.json()) as { entries: QueueEntry[] };
        setEntries(data.entries);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load queue");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [department],
  );

  useEffect(() => {
    void refresh();
    const source = new EventSource("/api/events");
    const onEvent = () => void refresh();
    source.addEventListener("queue_changed", onEvent);
    source.addEventListener("queue.queued", onEvent);
    return () => {
      source.removeEventListener("queue_changed", onEvent);
      source.removeEventListener("queue.queued", onEvent);
      source.close();
    };
  }, [refresh]);

  const visibleEntries = limit ? entries.slice(0, limit) : entries;

  return (
    <section
      data-testid={testId}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              {title ?? `${department} queue`}
            </h2>
            {!loading ? (
              <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                {entries.length} {entries.length === 1 ? "patient" : "patients"}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Ordered by clinical priority, then arrival time.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh(true)}
            aria-label="Refresh queue"
            disabled={refreshing}
          >
            <RefreshCw aria-hidden="true" className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="p-5" aria-hidden="true">
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-10 flex-1" />
                <Skeleton className="h-10 w-24 hidden sm:block" />
                <Skeleton className="h-10 w-20" />
              </div>
            ))}
          </div>
          <span className="sr-only">Loading queue</span>
        </div>
      ) : error ? (
        <div className="p-5">
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-lg border border-[var(--status-critical)]/20 bg-[var(--status-critical-background)]/40 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className="mt-0.5 size-4 shrink-0 text-[var(--status-critical)]"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-foreground">Could not load the queue</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh(true)}>
              Try again
            </Button>
          </div>
        </div>
      ) : entries.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Users}
            title={`No patients waiting in ${department}`}
            description="When a patient is registered and checked in, they will appear here automatically."
            data-testid="queue-empty"
            className="py-10"
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table
            className={cn(
              "w-full border-collapse text-left text-sm",
              compact ? "min-w-0" : "min-w-[640px]",
            )}
          >
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs tracking-wide text-muted-foreground uppercase">
                <th className="px-5 py-3 font-medium">Patient</th>
                {!compact ? <th className="px-5 py-3 font-medium">MRN</th> : null}
                {!compact ? <th className="px-5 py-3 font-medium">Encounter</th> : null}
                <th className="px-5 py-3 font-medium">Priority</th>
                <th className="px-5 py-3 font-medium">Waiting</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => {
                const priority = PRIORITY_META[entry.priority];
                return (
                  <tr
                    key={entry.id}
                    data-testid={`queue-row-${entry.id}`}
                    className="border-b border-border/70 last:border-b-0 hover:bg-muted/20"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn("mt-0.5 size-2 shrink-0 rounded-full", priority.dot)}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">
                            {entry.firstName} {entry.lastName}
                          </div>
                          {compact ? (
                            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                              {entry.mrn}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    {!compact ? (
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted-foreground">
                        {entry.mrn}
                      </td>
                    ) : null}
                    {!compact ? (
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted-foreground">
                        {entry.encounterNo}
                      </td>
                    ) : null}
                    <td className="px-5 py-3">
                      <Badge variant="outline" className={cn("font-medium", priority.className)}>
                        {priority.label}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-foreground">
                        <Clock3 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        {now === null ? "—" : waitTime(entry.queuedAt, now)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-sm capitalize text-muted-foreground">
                      {statusLabel(entry.status)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {limit && entries.length > limit ? (
            <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-5 py-2.5 text-xs text-muted-foreground">
              <span>
                Showing {visibleEntries.length} of {entries.length} waiting
              </span>
              <span>Open the queue for the full list</span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
