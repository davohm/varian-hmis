"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface QueueEntry {
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

const PRIORITY_STYLES: Record<QueueEntry["priority"], string> = {
  red: "border-l-[var(--status-critical)] text-[var(--status-critical-foreground)]",
  yellow: "border-l-[var(--status-warning)] text-[var(--status-warning-foreground)]",
  green: "border-l-[var(--status-normal)] text-[var(--status-normal-foreground)]",
  normal: "border-l-border text-foreground",
};

function waitTime(queuedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function QueueTable({
  department = "Triage",
  testId = "live-queue",
  compact = false,
}: {
  department?: string;
  testId?: string;
  compact?: boolean;
}) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/queue?department=${encodeURIComponent(department)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as { entries: QueueEntry[] };
      setEntries(data.entries);
    } finally {
      setLoading(false);
    }
  }, [department]);

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

  return (
    <div data-testid={testId} className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-primary">{department} queue</h2>
          <p className="text-xs text-muted-foreground">Priority order, then arrival time</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label="Refresh queue">
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>

      {loading ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Loading queue…</p>
      ) : entries.length === 0 ? (
        <p data-testid="queue-empty" className="px-4 py-6 text-sm text-muted-foreground">
          No patients waiting in {department}.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary text-xs tracking-wide text-secondary-foreground uppercase">
                <th className="px-4 py-2 font-medium">MRN</th>
                <th className="px-4 py-2 font-medium">Patient</th>
                {!compact ? <th className="px-4 py-2 font-medium">Encounter</th> : null}
                <th className="px-4 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Waiting</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  data-testid={`queue-row-${entry.id}`}
                  className="border-b border-l-4 border-b-border last:border-b-0"
                >
                  <td className={`px-4 py-2 font-mono text-xs ${PRIORITY_STYLES[entry.priority]} border-l-current`}>
                    <span className="font-mono text-foreground">{entry.mrn}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-medium">{entry.firstName} {entry.lastName}</span>
                  </td>
                  {!compact ? (
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                      {entry.encounterNo}
                    </td>
                  ) : null}
                  <td className="px-4 py-2">
                    <Badge variant="outline" className={PRIORITY_STYLES[entry.priority]}>
                      {entry.priority}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums">
                    {waitTime(entry.queuedAt)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{entry.status.replace("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
