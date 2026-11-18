"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, CheckCircle2, HeartPulse, RefreshCw, Route, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { cn } from "cn";

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

interface RecordTriageResult {
  triageVitalsId: string;
  doctorQueueEntryId: string;
  bmi: number | null;
  category: TriageCategory;
  suggestedCategory: TriageCategory;
}

const PRIORITY_BAR: Record<QueueEntry["priority"], string> = {
  red: "border-l-[var(--status-critical)]",
  yellow: "border-l-[var(--status-warning)]",
  green: "border-l-[var(--status-normal)]",
  normal: "border-l-border",
};

const PRIORITY_BADGE: Record<QueueEntry["priority"], string> = {
  red: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  yellow:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  green:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  normal: "border-border bg-secondary text-secondary-foreground",
};

const CATEGORY_STYLES: Record<TriageCategory, string> = {
  red: "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
  yellow:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  green:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
};

const TEXTAREA_CLASS =
  "mt-1 min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

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

function waitTime(queuedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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

export function TriageWorkspace() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<QueueEntry | null>(null);
  const [pending, setPending] = useState(false);
  const [lastResult, setLastResult] = useState<{
    name: string;
    mrn: string;
    category: TriageCategory;
    bmi: number | null;
  } | null>(null);
  const keysRef = useRef<Record<string, string>>({});
  const categoryTouched = useRef(false);

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

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/queue?department=Triage", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { entries: QueueEntry[] };
      setEntries(data.entries);
      setSelected((current) =>
        current && data.entries.some((entry) => entry.id === current.id) ? current : null,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    const source = new EventSource("/api/events");
    const onEvent = () => void refresh();
    source.addEventListener("queue_changed", onEvent);
    source.addEventListener("queue.queued", onEvent);
    source.addEventListener("triage.recorded", onEvent);
    return () => {
      clearInterval(interval);
      source.removeEventListener("queue_changed", onEvent);
      source.removeEventListener("queue.queued", onEvent);
      source.removeEventListener("triage.recorded", onEvent);
      source.close();
    };
  }, [refresh]);

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

  function selectPatient(entry: QueueEntry) {
    setSelected(entry);
    setLastResult(null);
    categoryTouched.current = entry.priority !== "normal";
    reset({
      ...DEFAULT_VALUES,
      category: entry.priority === "normal" ? "green" : entry.priority,
    });
  }

  const onSubmit = handleSubmit(async (formValues) => {
    if (!selected) return;
    setPending(true);
    try {
      const result = await postJson<RecordTriageResult>("/api/triage/vitals", {
        encounterId: selected.encounterId,
        queueEntryId: selected.id,
        idempotencyKey: keyFor(selected.id),
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
      });
      toast.success(
        `${selected.firstName} ${selected.lastName} routed to the doctor queue (${TRIAGE_CATEGORY_LABELS[result.category].toLowerCase()})`,
      );
      delete keysRef.current[selected.id];
      setSelected(null);
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
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.4fr)]">
      <section
        data-testid="triage-live-queue"
        className="overflow-hidden rounded-lg border border-border bg-card"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-primary">Triage queue</h2>
            <p className="text-xs text-muted-foreground">Priority order, then arrival time</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{entries.length}</Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refresh()}
              aria-label="Refresh triage queue"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading triage queue…</p>
        ) : entries.length === 0 ? (
          <div data-testid="triage-queue-empty" className="px-4 py-8 text-sm text-muted-foreground">
            <HeartPulse className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            No patients waiting in triage.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => {
              const active = selected?.id === entry.id;
              return (
                <li key={entry.id} data-testid={`queue-row-${entry.id}`}>
                  <button
                    type="button"
                    onClick={() => selectPatient(entry)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 border-l-4 px-4 py-3 text-left transition-colors hover:bg-secondary",
                      PRIORITY_BAR[entry.priority],
                      active && "bg-secondary",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {entry.firstName} {entry.lastName}
                      </span>
                      <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                        {entry.mrn} · {entry.encounterNo}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="outline" className={PRIORITY_BADGE[entry.priority]}>
                        {entry.priority}
                      </Badge>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {waitTime(entry.queuedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-primary">Vitals &amp; triage assessment</h2>
          <p className="text-xs text-muted-foreground">
            Amber marks an out-of-range vital; red marks a critical value.
          </p>
        </div>

        <div className="p-4">
          {lastResult ? (
            <div
              data-testid="triage-success"
              className="mb-4 rounded-md border border-[var(--status-normal)] bg-[var(--status-normal-background)] px-3 py-2 text-xs text-[var(--status-normal-foreground)]"
            >
              <CheckCircle2 className="mr-1 inline size-3.5" aria-hidden="true" />
              <span className="font-medium">{lastResult.name}</span> ·{" "}
              <span className="font-mono">{lastResult.mrn}</span> routed as{" "}
              <span className="font-semibold">
                {TRIAGE_CATEGORY_LABELS[lastResult.category].toLowerCase()}
              </span>
              {lastResult.bmi == null ? null : <> · BMI {formatBmi(lastResult.bmi)}</>}
            </div>
          ) : null}

          {!selected ? (
            <div
              data-testid="triage-no-selection"
              className="flex min-h-52 flex-col items-center justify-center rounded-md border border-dashed border-border bg-secondary/40 px-6 py-10 text-center"
            >
              <UserRound className="size-7 text-muted-foreground" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">Select a patient from the triage queue</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                Record their observations, choose a triage category and route them to the doctor.
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-5">
              <div
                data-testid="triage-patient-banner"
                className="sticky top-0 z-10 rounded-md border border-border bg-card px-3 py-3 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold">
                      {selected.firstName} {selected.lastName}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {selected.mrn} · {selected.encounterNo}
                    </p>
                  </div>
                  <Badge variant="outline" className={PRIORITY_BADGE[selected.priority]}>
                    {selected.priority}
                  </Badge>
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
                    <dd className="font-medium capitalize">{selected.payerType}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Allergies</dt>
                    <dd className="font-medium">
                      {selected.allergies.length > 0 ? selected.allergies.join(", ") : "None recorded"}
                    </dd>
                  </div>
                </dl>
              </div>

              <div>
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Observations
                </h3>
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
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/60 px-3 py-2">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Route className="size-4" aria-hidden="true" />
                  Saving removes this patient from triage and adds them to the Doctor queue.
                </p>
                <Button type="submit" data-testid="record-triage" disabled={pending}>
                  <AlertTriangle aria-hidden="true" />
                  {pending ? "Recording…" : "Record vitals & route"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
