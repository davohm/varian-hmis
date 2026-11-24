"use client";

import {
  AlertCircle,
  Clock3,
  RefreshCw,
  Search,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { QueueEntry } from "@/components/reception/queue-table";
import type { SearchResult } from "@/components/reception/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type FrontDeskPatient = SearchResult & { createdAt?: string };

type FrontDeskStatus = QueueEntry["status"] | "ready";

interface FrontDeskRow {
  id: string;
  kind: "queue" | "patient";
  patientId: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  mrn: string;
  phone: string | null;
  dob: string | null;
  sex: string;
  timestamp: string;
  priority: QueueEntry["priority"];
  status: FrontDeskStatus;
  selected: boolean;
  encounterNo?: string;
  queueId?: string;
}

const STATUS_META: Record<
  FrontDeskStatus,
  { monogram: string; short: string; label: string; className: string }
> = {
  waiting: {
    monogram: "WT",
    short: "Triage",
    label: "Waiting for triage",
    className:
      "border-[var(--status-warning)]/30 bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  },
  ready: {
    monogram: "RD",
    short: "Ready",
    label: "Ready to check in",
    className: "border-border bg-secondary text-secondary-foreground",
  },
  called: {
    monogram: "CL",
    short: "Called",
    label: "Called",
    className:
      "border-[var(--status-info)]/30 bg-[var(--status-info-background)] text-[var(--status-info-foreground)]",
  },
  in_service: {
    monogram: "IN",
    short: "In care",
    label: "In service",
    className:
      "border-[var(--status-normal)]/30 bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  },
  done: {
    monogram: "DN",
    short: "Done",
    label: "Done",
    className: "border-border bg-muted text-muted-foreground",
  },
  cancelled: {
    monogram: "CN",
    short: "Cancelled",
    label: "Cancelled",
    className:
      "border-[var(--status-critical)]/30 bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  },
};

const PRIORITY_META: Record<
  QueueEntry["priority"],
  { label: string; className: string }
> = {
  red: {
    label: "Emergency",
    className: "bg-[var(--status-critical)]",
  },
  yellow: {
    label: "Urgent",
    className: "bg-[var(--status-warning)]",
  },
  green: {
    label: "Fast track",
    className: "bg-[var(--status-normal)]",
  },
  normal: {
    label: "Normal",
    className: "bg-muted-foreground/50",
  },
};

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function initials(row: Pick<FrontDeskRow, "firstName" | "lastName">): string {
  return `${row.firstName[0] ?? ""}${row.lastName[0] ?? ""}`.toUpperCase();
}

function rowToPatient(row: FrontDeskRow): SearchResult {
  return {
    id: row.patientId,
    mrn: row.mrn,
    firstName: row.firstName,
    lastName: row.lastName,
    otherNames: row.otherNames,
    phone: row.phone,
    dob: row.dob,
    sex: row.sex,
  };
}

function ageFromDob(dob: string | null): string | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const years = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? `${years}y` : null;
}

function waitTime(timestamp: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function timestampValue(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

/**
 * This is a recent-activity view, not the clinical queue: newest activity leads
 * and both row kinds get a reserved share so neither can hide the other.
 * The clinical priority/arrival order stays on the full queue page.
 */
function selectVisibleRows(rows: FrontDeskRow[], limit: number): FrontDeskRow[] {
  const byNewest = (a: FrontDeskRow, b: FrontDeskRow) =>
    timestampValue(b.timestamp) - timestampValue(a.timestamp);
  const queued = rows.filter((row) => row.kind === "queue").sort(byNewest);
  const registered = rows.filter((row) => row.kind === "patient").sort(byNewest);

  const picked: FrontDeskRow[] = [];
  const seen = new Set<string>();
  const add = (row: FrontDeskRow) => {
    if (picked.length >= limit || seen.has(row.id)) return;
    picked.push(row);
    seen.add(row.id);
  };

  // A patient chosen in the check-in modal always has a visible home in this table.
  rows.filter((row) => row.selected).forEach(add);

  const queueShare = Math.ceil(limit / 2);
  const patientShare = Math.floor(limit / 2);
  queued.slice(0, queueShare).forEach(add);
  registered.slice(0, patientShare).forEach(add);

  if (picked.length < limit) {
    for (const row of [...queued.slice(queueShare), ...registered.slice(patientShare)]) {
      add(row);
    }
  }

  return picked;
}

function StatusBadge({ status }: { status: FrontDeskStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <Badge
        variant="outline"
        aria-hidden="true"
        className={cn(
          "size-7 shrink-0 justify-center rounded-lg p-0 font-mono text-[10px] font-semibold tracking-tight",
          meta.className,
        )}
      >
        {meta.monogram}
      </Badge>
      <span className="sr-only">{meta.label}</span>
      <span aria-hidden="true" className="hidden text-xs text-muted-foreground 2xl:inline">
        {meta.short}
      </span>
    </span>
  );
}

export function FrontDeskTable({
  patients,
  queue,
  selectedPatient,
  onSelectPatient,
  onStartVisit,
  checkingIn = false,
  limit = 8,
}: {
  patients: FrontDeskPatient[];
  queue: QueueEntry[];
  selectedPatient: SearchResult | null;
  onSelectPatient: (patient: SearchResult) => void;
  onStartVisit: (patient: SearchResult) => void | Promise<boolean>;
  checkingIn?: boolean;
  limit?: number;
}) {
  const [entries, setEntries] = useState<QueueEntry[]>(queue);
  const [now, setNow] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "waiting" | "ready">("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | QueueEntry["priority"]>("all");
  const [windowFilter, setWindowFilter] = useState<"all" | "today" | "week">("all");

  useEffect(() => setEntries(queue), [queue]);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/queue?department=Triage", { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load queue (${response.status})`);
      const data = (await response.json()) as { entries: QueueEntry[] };
      setEntries(data.entries);
      setError(null);
    } catch (caught) {
      // Keep the last good queue on screen while the retry affordance is shown.
      setError(caught instanceof Error ? caught.message : "Could not load the queue");
    } finally {
      setRefreshing(false);
    }
  }, []);

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

  const rows = useMemo<FrontDeskRow[]>(() => {
    const selected = selectedPatient
      ? { ...selectedPatient, createdAt: selectedPatient.createdAt ?? new Date().toISOString() }
      : null;
    const allPatients = selected
      ? [selected, ...patients.filter((patient) => patient.id !== selected.id)]
      : patients;
    const patientById = new Map(allPatients.map((patient) => [patient.id, patient]));
    const queuedPatientIds = new Set(entries.map((entry) => entry.patientId));

    const queueRows = entries.map((entry) => {
      const patient = patientById.get(entry.patientId);
      return {
        id: `queue-${entry.id}`,
        kind: "queue" as const,
        patientId: entry.patientId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        otherNames: patient?.otherNames ?? null,
        mrn: entry.mrn,
        phone: patient?.phone ?? null,
        dob: patient?.dob ?? null,
        sex: patient?.sex ?? "",
        timestamp: entry.queuedAt,
        priority: entry.priority,
        status: entry.status,
        selected: false,
        encounterNo: entry.encounterNo,
        queueId: entry.id,
      };
    });

    const patientRows = allPatients
      .filter((patient) => patient.id === selected?.id || !queuedPatientIds.has(patient.id))
      .map((patient) => ({
        id: `patient-${patient.id}`,
        kind: "patient" as const,
        patientId: patient.id,
        firstName: patient.firstName,
        lastName: patient.lastName,
        otherNames: patient.otherNames,
        mrn: patient.mrn,
        phone: patient.phone,
        dob: patient.dob,
        sex: patient.sex,
        timestamp: patient.createdAt ?? "",
        priority: "normal" as const,
        status: "ready" as const,
        selected: patient.id === selected?.id,
      }));

    return [...queueRows, ...patientRows];
  }, [patients, entries, selectedPatient]);

  const filteredRows = useMemo(() => {
    const term = query.trim().toLowerCase();
    const reference = now;

    return rows.filter((row) => {
      if (
        term &&
        !`${row.firstName} ${row.lastName} ${row.mrn} ${row.phone ?? ""}`
          .toLowerCase()
          .includes(term)
      ) {
        return false;
      }
      if (statusFilter === "waiting" && row.status !== "waiting") return false;
      if (statusFilter === "ready" && row.status !== "ready") return false;
      if (priorityFilter !== "all" && row.priority !== priorityFilter) return false;
      if (reference !== null && windowFilter !== "all" && row.timestamp) {
        const age = reference - new Date(row.timestamp).getTime();
        const cutoff = windowFilter === "today" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        if (!Number.isFinite(age) || age > cutoff) return false;
      }
      return true;
    });
  }, [rows, query, statusFilter, priorityFilter, windowFilter, now]);

  const visibleRows = selectVisibleRows(filteredRows, limit);
  const hasFilters = query.trim().length > 0 || statusFilter !== "all" || priorityFilter !== "all" || windowFilter !== "all";

  function clearFilters() {
    setQuery("");
    setStatusFilter("all");
    setPriorityFilter("all");
    setWindowFilter("all");
  }

  return (
    <section
      data-testid="reception-queue"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      aria-busy={refreshing}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">Patient flow</h2>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {filteredRows.length}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Recent records and the live triage queue in one view.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/reception/queue" />}>
            Full queue
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh(true)}
            aria-label="Refresh patient flow"
            disabled={refreshing}
          >
            <RefreshCw aria-hidden="true" className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b border-border/70 bg-muted/20 px-5 py-4 lg:flex-row lg:items-end">
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Patient
          </span>
          <span className="relative block">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="h-9 pr-9 pl-9 text-sm"
              placeholder="Name, MRN or phone"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter patient flow"
              maxLength={100}
              autoComplete="off"
              style={{}}
            />
            {query ? (
              <button
                type="button"
                className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setQuery("")}
                aria-label="Clear patient filter"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        </label>
        <label className="w-full lg:w-44">
          <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Status
          </span>
          <select
            className={SELECT_CLASS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="waiting">Waiting for triage</option>
            <option value="ready">Ready to check in</option>
          </select>
        </label>
        <label className="w-full lg:w-40">
          <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Priority
          </span>
          <select
            className={SELECT_CLASS}
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}
            aria-label="Filter by priority"
          >
            <option value="all">All priorities</option>
            {Object.entries(PRIORITY_META).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
        </label>
        <label className="w-full lg:w-40">
          <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Added
          </span>
          <select
            className={SELECT_CLASS}
            value={windowFilter}
            onChange={(event) => setWindowFilter(event.target.value as typeof windowFilter)}
            aria-label="Filter by date added"
          >
            <option value="all">Any time</option>
            <option value="today">Last 24 hours</option>
            <option value="week">Last 7 days</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--status-critical)]/20 bg-[var(--status-critical-background)]/35 px-5 py-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4 text-[var(--status-critical)]" aria-hidden="true" />
            Queue refresh failed{error ? ` — ${error}` : ""}. Showing the last received list.
          </p>
          <Button variant="outline" size="sm" onClick={() => void refresh(true)}>
            Try again
          </Button>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-xs tracking-wide text-muted-foreground uppercase">
              <th scope="col" className="px-5 py-3 font-medium">Patient</th>
              <th scope="col" className="px-5 py-3 font-medium">MRN</th>
              <th scope="col" className="px-5 py-3 font-medium">Stage</th>
              <th scope="col" className="px-5 py-3 font-medium">Priority</th>
              <th scope="col" className="px-5 py-3 font-medium">Waiting</th>
              <th scope="col" className="px-5 py-3 font-medium">Status</th>
              <th scope="col" className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length > 0 ? (
              visibleRows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={row.queueId ? `queue-row-${row.queueId}` : `patient-row-${row.patientId}`}
                  data-selected={row.selected || undefined}
                  className={cn(
                    "border-b border-border/70 last:border-b-0 hover:bg-muted/20",
                    row.selected && "bg-[var(--status-normal-background)]/35",
                  )}
                >
                  <td className="px-5 py-3">
                    <div
                      data-testid={row.selected ? "selected-patient" : undefined}
                      className="flex items-center gap-3"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-primary">
                        {initials(row)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">
                          {row.firstName} {row.lastName}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {row.phone ?? ageFromDob(row.dob) ?? row.sex ?? "—"}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-muted-foreground">
                    {row.mrn}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {row.kind === "queue" ? (
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <span className="font-mono text-xs">{row.encounterNo}</span>
                        <span className="text-xs">Triage</span>
                      </span>
                    ) : row.selected ? (
                      <span className="text-xs font-medium text-primary">Selected for check-in</span>
                    ) : (
                      <span className="text-xs">Registration</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {row.kind === "queue" ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className={cn("size-2 rounded-full", PRIORITY_META[row.priority].className)}
                        />
                        {PRIORITY_META[row.priority].label}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3">
                    {row.kind === "queue" ? (
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-foreground">
                        <Clock3 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        {now === null ? "—" : waitTime(row.timestamp, now)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    {row.kind === "queue" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        nativeButton={false}
                        render={<Link href="/reception/queue" />}
                      >
                        View
                      </Button>
                    ) : row.selected ? (
                      <Button
                        type="button"
                        size="sm"
                        data-testid="start-visit-selected"
                        aria-label={`Start visit for ${row.firstName} ${row.lastName}`}
                        onClick={() => void onStartVisit(rowToPatient(row))}
                        disabled={checkingIn}
                      >
                        <UserCheck aria-hidden="true" />
                        {checkingIn ? "Checking in…" : "Start visit"}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onSelectPatient(rowToPatient(row))}
                      >
                        Check in
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr data-testid="queue-empty">
                <td colSpan={7} className="px-5 py-6">
                  <EmptyState
                    icon={Users}
                    headingLevel={3}
                    title={hasFilters ? "No patients match these filters" : "No patient activity yet"}
                    description={
                      hasFilters
                        ? "Try a different name, MRN, status or priority."
                        : "Registered patients and the live triage queue will appear here."
                    }
                    action={
                      hasFilters ? (
                        <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          nativeButton={false}
                          render={<Link href="/reception/register" />}
                        >
                          Register patient
                        </Button>
                      )
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 border-t border-border/70 bg-muted/15 px-5 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          Showing {visibleRows.length} of {filteredRows.length} patient
          {filteredRows.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-4">
          <Link href="/reception/patients" className="font-medium text-primary hover:underline">
            Patient registry
          </Link>
          <Link href="/reception/queue" className="font-medium text-primary hover:underline">
            Full queue
          </Link>
        </div>
      </div>
    </section>
  );
}
