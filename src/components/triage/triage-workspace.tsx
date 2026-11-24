"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  HeartPulse,
  PhoneCall,
  RefreshCw,
  Route,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_LABELS,
  TRIAGE_CATEGORY_RANK,
  VITAL_DEFINITIONS,
  VITAL_INPUT_LIMITS,
  ageFromDob,
  assessVitals,
  calculateBmi,
  deriveTriageCategory,
  formatBmi,
  hasAnyVital,
  isCategoryAtLeast,
  type MeasurementKey,
  type TriageCategory,
  type VitalAssessment,
  type VitalInput,
} from "@/lib/triage";
import { cn } from "@/lib/utils";

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
  sex: "male" | "female" | "other";
  dob: string | null;
  allergies: string[];
  payerType: "cash" | "sha" | "insurance";
}

interface RoomOption {
  id: string;
  name: string;
  department: string;
}

interface RecordTriageResult {
  triageVitalsId: string;
  doctorQueueEntryId: string;
  bmi: number | null;
  category: TriageCategory;
  suggestedCategory: TriageCategory;
}

const PRIORITY_META: Record<
  QueueEntry["priority"],
  { label: string; bar: string; badge: string }
> = {
  red: {
    label: "Emergency",
    bar: "border-l-[var(--status-critical)]",
    badge: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  },
  yellow: {
    label: "Priority",
    bar: "border-l-[var(--status-warning)]",
    badge: "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  },
  green: {
    label: "Fast track",
    bar: "border-l-[var(--status-normal)]",
    badge: "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  },
  normal: {
    label: "Normal",
    bar: "border-l-border",
    badge: "border-border bg-secondary text-secondary-foreground",
  },
};

const PAYER_LABELS: Record<QueueEntry["payerType"], string> = {
  cash: "Cash",
  sha: "SHA",
  insurance: "Insurance",
};

const STATUS_META: Record<QueueEntry["status"], { label: string; badge: string }> = {
  waiting: { label: "Waiting", badge: "border-border bg-secondary text-secondary-foreground" },
  called: {
    label: "Called",
    badge: "border-[var(--status-info)] bg-[var(--status-info-background)] text-[var(--status-info-foreground)]",
  },
  in_service: {
    label: "In care",
    badge: "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  },
  done: { label: "Done", badge: "border-border bg-muted text-muted-foreground" },
  cancelled: {
    label: "Cancelled",
    badge: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  },
};

const CATEGORY_STYLES: Record<TriageCategory, string> = {
  red: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  yellow:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  green:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
};

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60";

const TEXTAREA_CLASS =
  "mt-1 min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

const QUEUE_EVENTS = ["queue_changed", "queue.queued", "triage.recorded", "triage.called"] as const;

const optionalNumberText = (key: MeasurementKey) =>
  z.string().refine((value) => {
    if (value.trim() === "") return true;
    const parsed = Number(value);
    const limits = VITAL_INPUT_LIMITS[key];
    return Number.isFinite(parsed) && parsed >= limits.min && parsed <= limits.max;
  }, `Enter a value from ${VITAL_INPUT_LIMITS[key].min} to ${VITAL_INPUT_LIMITS[key].max}`);

const formSchema = z
  .object({
    systolic: optionalNumberText("systolic"),
    diastolic: optionalNumberText("diastolic"),
    heartRate: optionalNumberText("heartRate"),
    respRate: optionalNumberText("respRate"),
    temperature: optionalNumberText("temperature"),
    spo2: optionalNumberText("spo2"),
    weightKg: optionalNumberText("weightKg"),
    heightCm: optionalNumberText("heightCm"),
    painScore: optionalNumberText("painScore"),
    muacCm: optionalNumberText("muacCm"),
    category: z.enum(TRIAGE_CATEGORIES),
    chiefComplaint: z.string().trim().min(2, "Record the chief complaint"),
    comments: z.string(),
    nextSteps: z.string(),
  })
  .superRefine((values, context) => {
    const vitals = parseVitals(values);
    const suggested = deriveTriageCategory(assessVitals(vitals));

    if (!hasAnyVital(vitals)) {
      context.addIssue({
        code: "custom",
        path: ["systolic"],
        message: "Record at least one vital sign",
      });
    }

    if ((vitals.systolic == null) !== (vitals.diastolic == null)) {
      context.addIssue({
        code: "custom",
        path: ["diastolic"],
        message: "Enter both systolic and diastolic blood pressure",
      });
    }

    if (!isCategoryAtLeast(values.category, suggested)) {
      context.addIssue({
        code: "custom",
        path: ["category"],
        message: `Vitals require ${TRIAGE_CATEGORY_LABELS[suggested].toLowerCase()} or higher`,
      });
    }
  });

type TriageFormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: TriageFormValues = {
  systolic: "",
  diastolic: "",
  heartRate: "",
  respRate: "",
  temperature: "",
  spo2: "",
  weightKg: "",
  heightCm: "",
  painScore: "",
  muacCm: "",
  category: "green",
  chiefComplaint: "",
  comments: "",
  nextSteps: "",
};

function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVitals(values: TriageFormValues): VitalInput {
  return {
    systolic: numberOrNull(values.systolic),
    diastolic: numberOrNull(values.diastolic),
    heartRate: numberOrNull(values.heartRate),
    respRate: numberOrNull(values.respRate),
    temperature: numberOrNull(values.temperature),
    spo2: numberOrNull(values.spo2),
    weightKg: numberOrNull(values.weightKg),
    heightCm: numberOrNull(values.heightCm),
    painScore: numberOrNull(values.painScore),
    muacCm: numberOrNull(values.muacCm),
  };
}

function initials(entry: QueueEntry): string {
  return `${entry.firstName[0] ?? ""}${entry.lastName[0] ?? ""}`.toUpperCase();
}

function waitTime(queuedAt: string, now: number | null): string {
  if (now == null) return "—";
  const started = Date.parse(queuedAt);
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function useClock(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

class SessionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMismatchError";
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "triage-station" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
      detail?: string;
      issues?: Array<{ message?: string }>;
    } | null;
    const message =
      detail?.issues?.[0]?.message ??
      detail?.detail ??
      detail?.error ??
      `Request failed (${response.status})`;
    if (response.status === 401 || response.status === 403) {
      throw new SessionMismatchError(message);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function handleSessionMismatch(error: unknown): Promise<boolean> {
  if (!(error instanceof SessionMismatchError)) return false;
  toast.error("Your session changed. Returning to your workspace.");
  window.location.assign("/");
  return true;
}

function VitalField({
  id,
  label,
  unit,
  registration,
  assessment,
  error,
  step = "1",
  testId,
}: {
  id: string;
  label: string;
  unit: string;
  registration: UseFormRegisterReturn;
  assessment?: VitalAssessment;
  error?: string;
  step?: string;
  testId?: string;
}) {
  const flag = assessment?.flag ?? "normal";
  const flagClass =
    flag === "critical"
      ? "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
      : flag === "warning"
        ? "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
        : "";

  return (
    <div>
      <Label htmlFor={id} className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className="font-normal text-muted-foreground">{unit}</span>
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        data-testid={testId ?? `vitals-${id}`}
        data-flag={flag}
        aria-invalid={Boolean(error)}
        className={cn("mt-1 tabular-nums", flagClass)}
        {...registration}
      />
      {assessment && assessment.flag !== "normal" ? (
        <p
          data-testid={`vital-flag-${id}`}
          className={cn(
            "mt-1 text-xs font-medium",
            // The -foreground tokens are the AA-contrast pair for text on the
            // card surface; the brighter base tokens carry dark mode.
            assessment.flag === "critical"
              ? "text-[var(--status-critical-foreground)] dark:text-[var(--status-critical)]"
              : "text-[var(--status-warning-foreground)] dark:text-[var(--status-warning)]",
          )}
        >
          {assessment.flag === "critical" ? "Critical" : "Out of range"}{" "}
          {assessment.direction === "low" ? "low" : "high"}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

type StatusFilter = "all" | "waiting" | "called" | "in_service";
type PriorityFilter = "all" | QueueEntry["priority"];

function TriageQueuePanel({
  entries,
  loading,
  refreshing,
  error,
  live,
  selectedId,
  onRefresh,
  onReconnect,
  onSelect,
}: {
  entries: QueueEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  live: boolean;
  selectedId: string | null;
  onRefresh: () => void;
  onReconnect: () => void;
  onSelect: (entry: QueueEntry) => void;
}) {
  const now = useClock(1_000);
  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (
        term &&
        !`${entry.firstName} ${entry.lastName} ${entry.mrn} ${entry.encounterNo}`
          .toLowerCase()
          .includes(term)
      ) {
        return false;
      }
      if (priorityFilter !== "all" && entry.priority !== priorityFilter) return false;
      if (statusFilter !== "all" && entry.status !== statusFilter) return false;
      return true;
    });
  }, [entries, query, priorityFilter, statusFilter]);

  const hasFilters = query.trim().length > 0 || priorityFilter !== "all" || statusFilter !== "all";

  function clearFilters() {
    setQuery("");
    setPriorityFilter("all");
    setStatusFilter("all");
  }

  return (
    <section
      data-testid="triage-live-queue"
      aria-busy={refreshing}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Triage queue</h2>
          <p className="mt-1 text-sm text-muted-foreground">Priority first, then arrival time.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live ? (
            <span
              data-testid="triage-live-status"
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--status-normal-background)] px-2 py-1 text-[11px] font-medium text-[var(--status-normal-foreground)]"
            >
              <span className="size-1.5 rounded-full bg-[var(--status-normal)]" aria-hidden="true" />
              Live
            </span>
          ) : (
            <button
              type="button"
              data-testid="triage-reconnect"
              onClick={onReconnect}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--status-warning-background)] px-2 py-1 text-[11px] font-medium text-[var(--status-warning-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AlertCircle className="size-3" aria-hidden="true" />
              Updates paused. Reconnect
            </button>
          )}
          <Badge variant="secondary" className="font-mono text-[10px]">
            {filtered.length}/{entries.length}
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            aria-label="Refresh triage queue"
            disabled={refreshing}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden="true" />
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
              placeholder="Name, MRN or encounter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search triage queue"
              maxLength={100}
              autoComplete="off"
            />
            {query ? (
              <button
                type="button"
                className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setQuery("")}
                aria-label="Clear queue search"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        </label>
        <label className="w-full lg:w-40">
          <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Priority
          </span>
          <select
            className={SELECT_CLASS}
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as PriorityFilter)}
            aria-label="Filter triage queue by priority"
          >
            <option value="all">All priorities</option>
            {Object.entries(PRIORITY_META).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
        </label>
        <label className="w-full lg:w-36">
          <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Stage
          </span>
          <select
            className={SELECT_CLASS}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            aria-label="Filter triage queue by stage"
          >
            <option value="all">All stages</option>
            {(["waiting", "called", "in_service"] as const).map((status) => (
              <option key={status} value={status}>
                {STATUS_META[status].label}
              </option>
            ))}
          </select>
        </label>
        {hasFilters ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--status-critical)]/20 bg-[var(--status-critical-background)]/35 px-5 py-3"
        >
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4 text-[var(--status-critical)]" aria-hidden="true" />
            Queue refresh failed: {error}. Showing the last received list.
          </p>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            Try again
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-4 px-5 py-5" aria-label="Loading triage queue">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="p-5">
          <EmptyState
            data-testid="triage-queue-empty"
            icon={HeartPulse}
            headingLevel={3}
            title="No patients waiting for triage"
            description="New visits from reception appear here as soon as they are queued."
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Search}
            headingLevel={3}
            title="No patients match these filters"
            description="Clear the search or filters to see the full triage queue."
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {filtered.map((entry) => {
            const active = selectedId === entry.id;
            return (
              <li key={entry.id} data-testid={`queue-row-${entry.id}`}>
                <button
                  type="button"
                  onClick={() => onSelect(entry)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 border-l-4 px-4 py-3 text-left transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none",
                    PRIORITY_META[entry.priority].bar,
                    active && "bg-[var(--status-normal-background)]/40",
                  )}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-primary">
                    {initials(entry)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {entry.firstName} {entry.lastName}
                      </span>
                      {entry.status !== "waiting" ? (
                        <Badge
                          variant="outline"
                          className={cn("px-1.5 py-0 text-[9px]", STATUS_META[entry.status].badge)}
                        >
                          {STATUS_META[entry.status].label}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {entry.mrn} · {entry.encounterNo}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant="outline" className={PRIORITY_META[entry.priority].badge}>
                      {PRIORITY_META[entry.priority].label}
                    </Badge>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {waitTime(entry.queuedAt, now)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-border/70 px-5 py-2.5 text-[11px] text-muted-foreground">
        Waiting time updates every second. Live updates are {live ? "on" : "paused"}.
      </div>
    </section>
  );
}

export function TriageWorkspace() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [streamToken, setStreamToken] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [calling, setCalling] = useState(false);
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState("");
  const [lastResult, setLastResult] = useState<{
    name: string;
    mrn: string;
    category: TriageCategory;
    bmi: number | null;
    roomLabel: string | null;
  } | null>(null);
  const keysRef = useRef<Record<string, string>>({});
  const callKeysRef = useRef<Record<string, string>>({});
  const categoryTouched = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const departedNoticeRef = useRef<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<TriageFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const values = watch();
  const vitals = parseVitals(values);
  const assessments = assessVitals(vitals);
  const suggestedCategory = deriveTriageCategory(assessments);
  const bmi = calculateBmi(vitals.weightKg, vitals.heightCm);

  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );
  const sortedRooms = useMemo(
    () =>
      [...rooms].sort(
        (a, b) =>
          Number(b.department === "Doctor") - Number(a.department === "Doctor") ||
          a.name.localeCompare(b.name),
      ),
    [rooms],
  );
  const roomLabel = roomId
    ? (sortedRooms.find((room) => room.id === roomId)?.name ?? null)
    : null;

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/queue?department=Triage", { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load queue (${response.status})`);
      const data = (await response.json()) as { entries: QueueEntry[] };
      setEntries(data.entries);
      setQueueError(null);

      const current = selectedIdRef.current;
      if (current && !data.entries.some((entry) => entry.id === current)) {
        selectedIdRef.current = null;
        setSelectedId(null);
        if (departedNoticeRef.current !== current) {
          departedNoticeRef.current = current;
          toast.info("The selected patient has left the triage queue");
        }
      }
    } catch (caught) {
      // Keep the last good queue on screen while the retry affordance is shown.
      setQueueError(caught instanceof Error ? caught.message : "Could not load the queue");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshNow = useCallback(() => {
    setRefreshing(true);
    void refresh();
  }, [refresh]);

  const loadRooms = useCallback(async () => {
    try {
      setRoomsLoading(true);
      const response = await fetch("/api/triage/rooms", { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load rooms (${response.status})`);
      const data = (await response.json()) as { rooms: RoomOption[] };
      setRooms(data.rooms ?? []);
      setRoomsError(null);
    } catch (caught) {
      setRooms([]);
      setRoomsError(caught instanceof Error ? caught.message : "Could not load rooms");
    } finally {
      setRoomsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const source = new EventSource("/api/events");
    const onEvent = () => void refresh();
    const onOpen = () => setLive(true);
    const onError = () => setLive(false);
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    for (const event of QUEUE_EVENTS) source.addEventListener(event, onEvent);
    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      for (const event of QUEUE_EVENTS) source.removeEventListener(event, onEvent);
      source.close();
    };
  }, [refresh, streamToken]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  useEffect(() => {
    if (!categoryTouched.current) {
      if (values.category !== suggestedCategory) {
        setValue("category", suggestedCategory, { shouldValidate: false });
      }
      return;
    }

    if (!isCategoryAtLeast(values.category, suggestedCategory)) {
      setValue("category", suggestedCategory, { shouldValidate: false });
    }
  }, [setValue, suggestedCategory, values.category]);

  function keyFor(queueEntryId: string): string {
    if (!keysRef.current[queueEntryId]) {
      keysRef.current[queueEntryId] = crypto.randomUUID();
    }
    return keysRef.current[queueEntryId];
  }

  function callKeyFor(queueEntryId: string): string {
    if (!callKeysRef.current[queueEntryId]) {
      callKeysRef.current[queueEntryId] = crypto.randomUUID();
    }
    return callKeysRef.current[queueEntryId];
  }

  function selectPatient(entry: QueueEntry) {
    selectedIdRef.current = entry.id;
    departedNoticeRef.current = null;
    setSelectedId(entry.id);
    setLastResult(null);
    categoryTouched.current = entry.priority !== "normal";
    reset({
      ...DEFAULT_VALUES,
      category: entry.priority === "normal" ? "green" : entry.priority,
    });
  }

  function clearSelection() {
    selectedIdRef.current = null;
    setSelectedId(null);
    reset(DEFAULT_VALUES);
    categoryTouched.current = false;
  }

  async function callPatient() {
    if (!selected) return;
    setCalling(true);
    try {
      await postJson<{ queueEntryId: string; status: "called" }>("/api/triage/call", {
        queueEntryId: selected.id,
        idempotencyKey: callKeyFor(selected.id),
      });
      delete callKeysRef.current[selected.id];
      toast.success(`${selected.firstName} ${selected.lastName} called to triage`);
      await refresh();
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not call the patient");
    } finally {
      setCalling(false);
    }
  }

  const onSubmit = handleSubmit(async (formValues) => {
    if (!selected) return;
    setPending(true);
    try {
      const result = await postJson<RecordTriageResult>("/api/triage/vitals", {
        encounterId: selected.encounterId,
        queueEntryId: selected.id,
        idempotencyKey: keyFor(selected.id),
        roomId: roomId || null,
        category: formValues.category,
        chiefComplaint: formValues.chiefComplaint,
        comments: formValues.comments || null,
        nextSteps: formValues.nextSteps || null,
        ...parseVitals(formValues),
      });

      setLastResult({
        name: `${selected.firstName} ${selected.lastName}`,
        mrn: selected.mrn,
        category: result.category,
        bmi: result.bmi,
        roomLabel: roomLabel ? `${roomLabel} room` : null,
      });
      toast.success(
        `${selected.firstName} ${selected.lastName} routed to the doctor queue (${TRIAGE_CATEGORY_LABELS[result.category].toLowerCase()})`,
      );
      delete keysRef.current[selected.id];
      selectedIdRef.current = null;
      setSelectedId(null);
      reset(DEFAULT_VALUES);
      categoryTouched.current = false;
      await refresh();
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not record triage vitals");
    } finally {
      setPending(false);
    }
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
      <TriageQueuePanel
        entries={entries}
        loading={loading}
        refreshing={refreshing}
        error={queueError}
        live={live}
        selectedId={selectedId}
        onRefresh={refreshNow}
        onReconnect={() => setStreamToken((token) => token + 1)}
        onSelect={selectPatient}
      />

      <section className="rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border/80 px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">Vitals &amp; triage assessment</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Amber marks an out-of-range vital; red marks a critical value.
          </p>
        </div>

        <div className="p-5">
          {lastResult ? (
            <div
              data-testid="triage-success"
              role="status"
              className="mb-5 rounded-lg border border-[var(--status-normal)] bg-[var(--status-normal-background)] px-3 py-2.5 text-xs text-[var(--status-normal-foreground)]"
            >
              <CheckCircle2 className="mr-1 inline size-3.5" aria-hidden="true" />
              <span className="font-medium">{lastResult.name}</span> ·{" "}
              <span className="font-mono">{lastResult.mrn}</span> routed as{" "}
              <span className="font-semibold">
                {TRIAGE_CATEGORY_LABELS[lastResult.category].toLowerCase()}
              </span>
              {lastResult.roomLabel ? <> to {lastResult.roomLabel}</> : null}
              {lastResult.bmi == null ? null : <> · BMI {formatBmi(lastResult.bmi)}</>}
            </div>
          ) : null}

          {!selected ? (
            <EmptyState
              data-testid="triage-no-selection"
              icon={UserRound}
              headingLevel={3}
              title="Select a patient from the triage queue"
              description="Record their observations, choose a category and route them to a doctor."
              className="min-h-52"
            />
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-6">
              <div
                data-testid="triage-patient-banner"
                className="rounded-xl border border-border bg-secondary/30 px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold">
                        {selected.firstName} {selected.lastName}
                      </p>
                      <Badge variant="outline" className={PRIORITY_META[selected.priority].badge}>
                        {PRIORITY_META[selected.priority].label}
                      </Badge>
                      <Badge variant="outline" className={STATUS_META[selected.status].badge}>
                        {STATUS_META[selected.status].label}
                      </Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {selected.mrn} · {selected.encounterNo}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void callPatient()}
                      disabled={selected.status !== "waiting" || calling}
                      aria-label={`Call ${selected.firstName} ${selected.lastName} to triage`}
                    >
                      {selected.status === "waiting" ? (
                        <PhoneCall className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Check className="size-3.5" aria-hidden="true" />
                      )}
                      {calling
                        ? "Calling…"
                        : selected.status === "waiting"
                          ? "Call patient"
                          : "Called"}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={clearSelection}>
                      Clear
                    </Button>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">Age / sex</dt>
                    <dd className="font-medium">
                      {ageFromDob(selected.dob) ?? "—"} · {selected.sex}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Payer</dt>
                    <dd className="font-medium">{PAYER_LABELS[selected.payerType]}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Queue stage</dt>
                    <dd className="font-medium">{STATUS_META[selected.status].label}</dd>
                  </div>
                  <div className="col-span-2 sm:col-span-4">
                    <dt className="text-muted-foreground">Allergies</dt>
                    <dd className="font-medium">
                      {selected.allergies.length > 0 ? selected.allergies.join(", ") : "None recorded"}
                    </dd>
                  </div>
                </dl>
              </div>

              <fieldset className="min-w-0">
                <legend className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                  Vital signs
                </legend>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <VitalField
                    id="systolic"
                    label={VITAL_DEFINITIONS.systolic.label}
                    unit={VITAL_DEFINITIONS.systolic.unit}
                    registration={register("systolic")}
                    assessment={assessments.systolic}
                    error={errors.systolic?.message}
                  />
                  <VitalField
                    id="diastolic"
                    label={VITAL_DEFINITIONS.diastolic.label}
                    unit={VITAL_DEFINITIONS.diastolic.unit}
                    registration={register("diastolic")}
                    assessment={assessments.diastolic}
                    error={errors.diastolic?.message}
                  />
                  <VitalField
                    id="heartRate"
                    label={VITAL_DEFINITIONS.heartRate.label}
                    unit={VITAL_DEFINITIONS.heartRate.unit}
                    registration={register("heartRate")}
                    assessment={assessments.heartRate}
                    error={errors.heartRate?.message}
                  />
                  <VitalField
                    id="respRate"
                    label={VITAL_DEFINITIONS.respRate.label}
                    unit={VITAL_DEFINITIONS.respRate.unit}
                    registration={register("respRate")}
                    assessment={assessments.respRate}
                    error={errors.respRate?.message}
                  />
                  <VitalField
                    id="temperature"
                    label={VITAL_DEFINITIONS.temperature.label}
                    unit={VITAL_DEFINITIONS.temperature.unit}
                    registration={register("temperature")}
                    assessment={assessments.temperature}
                    error={errors.temperature?.message}
                    step="0.1"
                  />
                  <VitalField
                    id="spo2"
                    label={VITAL_DEFINITIONS.spo2.label}
                    unit={VITAL_DEFINITIONS.spo2.unit}
                    registration={register("spo2")}
                    assessment={assessments.spo2}
                    error={errors.spo2?.message}
                  />
                </div>
              </fieldset>

              <fieldset className="min-w-0">
                <legend className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                  Growth and comfort
                </legend>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <VitalField
                    id="weightKg"
                    label={VITAL_DEFINITIONS.weightKg.label}
                    unit={VITAL_DEFINITIONS.weightKg.unit}
                    registration={register("weightKg")}
                    assessment={assessments.weightKg}
                    error={errors.weightKg?.message}
                    step="0.1"
                  />
                  <VitalField
                    id="heightCm"
                    label={VITAL_DEFINITIONS.heightCm.label}
                    unit={VITAL_DEFINITIONS.heightCm.unit}
                    registration={register("heightCm")}
                    assessment={assessments.heightCm}
                    error={errors.heightCm?.message}
                    step="0.1"
                  />
                  <div
                    className={cn(
                      "rounded-md border border-border bg-secondary/60 px-3 py-2",
                      assessments.bmi?.flag === "critical" &&
                        "border-[var(--status-critical)] bg-[var(--status-critical-background)]",
                      assessments.bmi?.flag === "warning" &&
                        "border-[var(--status-warning)] bg-[var(--status-warning-background)]",
                    )}
                  >
                    <p className="text-xs text-muted-foreground">BMI (auto)</p>
                    <p
                      data-testid="vitals-bmi"
                      className="mt-1 font-mono text-lg font-semibold tabular-nums"
                    >
                      {formatBmi(bmi)}
                    </p>
                    {assessments.bmi && assessments.bmi.flag !== "normal" ? (
                      <p
                        data-testid="vital-flag-bmi"
                        className={cn(
                          "text-xs font-medium",
                          assessments.bmi.flag === "critical"
                            ? "text-[var(--status-critical-foreground)] dark:text-[var(--status-critical)]"
                            : "text-[var(--status-warning-foreground)] dark:text-[var(--status-warning)]",
                        )}
                      >
                        {assessments.bmi.flag === "critical" ? "Critical" : "Out of range"}{" "}
                        {assessments.bmi.direction === "low" ? "low" : "high"}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Calculated from weight and height</p>
                    )}
                  </div>
                  <VitalField
                    id="painScore"
                    label={VITAL_DEFINITIONS.painScore.label}
                    unit={VITAL_DEFINITIONS.painScore.unit}
                    registration={register("painScore")}
                    assessment={assessments.painScore}
                    error={errors.painScore?.message}
                  />
                  <VitalField
                    id="muacCm"
                    label={VITAL_DEFINITIONS.muacCm.label}
                    unit={VITAL_DEFINITIONS.muacCm.unit}
                    registration={register("muacCm")}
                    assessment={assessments.muacCm}
                    error={errors.muacCm?.message}
                    step="0.1"
                  />
                </div>
              </fieldset>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    Triage category
                  </h3>
                  <p data-testid="triage-suggested-category" className="text-xs text-muted-foreground">
                    Vitals suggest{" "}
                    <span className="font-semibold text-foreground">
                      {TRIAGE_CATEGORY_LABELS[suggestedCategory].toLowerCase()}
                    </span>
                  </p>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Triage category"
                  data-testid="triage-category"
                  className="mt-2 grid gap-2 sm:grid-cols-3"
                >
                  {TRIAGE_CATEGORIES.map((category) => {
                    const selectedCategory = values.category === category;
                    const disabled =
                      TRIAGE_CATEGORY_RANK[category] < TRIAGE_CATEGORY_RANK[suggestedCategory];
                    return (
                      <button
                        key={category}
                        type="button"
                        role="radio"
                        aria-checked={selectedCategory}
                        disabled={disabled}
                        data-testid={`category-${category}`}
                        onClick={() => {
                          categoryTouched.current = true;
                          setValue("category", category, { shouldValidate: true });
                        }}
                        className={cn(
                          "rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                          selectedCategory
                            ? CATEGORY_STYLES[category]
                            : "border-border bg-background hover:bg-secondary",
                        )}
                      >
                        <span className="block text-sm font-semibold capitalize">{category}</span>
                        <span className="block text-xs opacity-80">
                          {TRIAGE_CATEGORY_LABELS[category]}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {errors.category ? (
                  <p className="mt-1 text-xs text-destructive">{errors.category.message}</p>
                ) : null}
              </div>

              <div>
                <h3 className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                  Clinical notes
                </h3>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="chiefComplaint">Chief complaint *</Label>
                    <textarea
                      id="chiefComplaint"
                      data-testid="triage-chief-complaint"
                      className={TEXTAREA_CLASS}
                      aria-invalid={Boolean(errors.chiefComplaint)}
                      placeholder="e.g. Fever and headache for two days"
                      {...register("chiefComplaint")}
                    />
                    {errors.chiefComplaint ? (
                      <p className="mt-1 text-xs text-destructive">{errors.chiefComplaint.message}</p>
                    ) : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="comments">Nurse comments</Label>
                      <textarea
                        id="comments"
                        data-testid="triage-comments"
                        className={TEXTAREA_CLASS}
                        placeholder="Observations, concerns or context"
                        {...register("comments")}
                      />
                    </div>
                    <div>
                      <Label htmlFor="nextSteps">Next steps</Label>
                      <textarea
                        id="nextSteps"
                        data-testid="triage-next-steps"
                        className={TEXTAREA_CLASS}
                        placeholder="e.g. Doctor review, urgent assessment"
                        {...register("nextSteps")}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-secondary/40 p-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <label className="min-w-0 flex-1">
                    <span className="mb-1.5 block font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                      Doctor room
                    </span>
                    <select
                      id="triage-room"
                      data-testid="triage-room"
                      className={SELECT_CLASS}
                      value={roomId}
                      onChange={(event) => setRoomId(event.target.value)}
                      aria-label="Route to doctor room"
                      disabled={roomsLoading || Boolean(roomsError)}
                    >
                      <option value="">No room assigned</option>
                      {sortedRooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.name} · {room.department}
                        </option>
                      ))}
                    </select>
                    {roomsError ? (
                      <span className="mt-1.5 block text-xs text-muted-foreground">
                        Rooms unavailable ({roomsError}).{" "}
                        <button
                          type="button"
                          onClick={() => void loadRooms()}
                          className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Retry
                        </button>
                        . You can still route without a room.
                      </span>
                    ) : null}
                    {!roomsError && !roomsLoading && sortedRooms.length === 0 ? (
                      <span className="mt-1.5 block text-xs text-muted-foreground">
                        No active rooms are configured. The doctor queue will be unassigned.
                      </span>
                    ) : null}
                  </label>
                  <Button type="submit" data-testid="record-triage" disabled={pending} className="shrink-0">
                    <AlertTriangle aria-hidden="true" />
                    {pending ? "Recording…" : "Record vitals & route"}
                  </Button>
                </div>
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Route className="size-4 shrink-0" aria-hidden="true" />
                  Saving removes this patient from triage and adds them to the Doctor queue
                  {roomLabel ? ` in ${roomLabel}` : ""}.
                </p>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
