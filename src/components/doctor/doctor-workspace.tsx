"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileText,
  FlaskConical,
  Lock,
  Pill,
  Plus,
  RefreshCw,
  Stethoscope,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CLINICAL_NOTE_LOCKED_MESSAGE,
  DISCHARGE_OUTCOMES,
  DISCHARGE_OUTCOME_LABELS,
  LAB_RESULT_FLAG_LABELS,
  PRESCRIPTION_FREQUENCIES,
  PRESCRIPTION_ROUTES,
  SOAP_SECTIONS,
  canCancelLabOrder,
  canCancelPrescription,
  isAbnormalLabFlag,
  type DischargeOutcome,
} from "@/lib/clinical";
import {
  TRIAGE_CATEGORY_LABELS,
  VITAL_DEFINITIONS,
  ageFromDob,
  assessVitals,
  type MeasurementKey,
  type TriageCategory,
  type VitalFlag,
  type VitalInput,
} from "@/lib/triage";
import type {
  DrugOption,
  EncounterClinicalDetail,
  Icd10Option,
  LabTestOption,
} from "@/server/queries/clinical";
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
  status: string;
  queuedAt: string;
  sex: "male" | "female" | "other";
  dob: string | null;
  allergies: string[];
  payerType: "cash" | "sha" | "insurance";
}

type Detail = EncounterClinicalDetail;
type LabOrder = Detail["labOrders"][number];
type LabOrderItem = LabOrder["items"][number];
type Prescription = Detail["prescriptions"][number];
type Diagnosis = Detail["diagnoses"][number];

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

const FLAG_TEXT: Record<VitalFlag, string> = {
  normal: "text-foreground",
  warning: "text-[var(--status-warning-foreground)] dark:text-[var(--status-warning)]",
  critical: "text-[var(--status-critical-foreground)] dark:text-[var(--status-critical)]",
};

const FLAG_SURFACE: Record<VitalFlag, string> = {
  normal: "border-border bg-card",
  warning:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  critical:
    "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]",
};

const LAB_STATUS_LABELS: Record<string, string> = {
  ordered: "Ordered",
  collected: "Sample collected",
  in_progress: "In progress",
  resulted: "Resulted",
  verified: "Verified",
  cancelled: "Cancelled",
};

const LAB_STATUS_STYLES: Record<string, string> = {
  ordered: "border-border bg-secondary text-secondary-foreground",
  collected: "border-border bg-secondary text-secondary-foreground",
  in_progress:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  resulted: "border-border bg-secondary text-secondary-foreground",
  verified:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  cancelled: "border-border bg-muted text-muted-foreground",
};

const PRESCRIPTION_STATUS_STYLES: Record<string, string> = {
  prescribed: "border-border bg-secondary text-secondary-foreground",
  partial:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  dispensed:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  cancelled: "border-border bg-muted text-muted-foreground",
};

const ACTIVE_LAB_STATUSES = new Set(["ordered", "collected", "in_progress", "resulted"]);

const TEXTAREA_CLASS =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-60 dark:bg-input/30";

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30";

class SessionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMismatchError";
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "doctor-station" },
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

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function worstFlag(flags: Array<VitalFlag | undefined>): VitalFlag {
  if (flags.includes("critical")) return "critical";
  if (flags.includes("warning")) return "warning";
  return "normal";
}

interface VitalsInputs {
  vital: VitalInput;
  assessments: ReturnType<typeof assessVitals>;
}

function vitalsFromDetail(vitals: Detail["vitals"]): VitalsInputs {
  const vital: VitalInput = {
    systolic: vitals?.systolic ?? null,
    diastolic: vitals?.diastolic ?? null,
    heartRate: vitals?.heartRate ?? null,
    respRate: vitals?.respRate ?? null,
    temperature: toNumber(vitals?.temperature),
    spo2: vitals?.spo2 ?? null,
    weightKg: toNumber(vitals?.weightKg),
    heightCm: toNumber(vitals?.heightCm),
    painScore: vitals?.painScore ?? null,
    muacCm: toNumber(vitals?.muacCm),
  };
  return { vital, assessments: assessVitals(vital) };
}

function SectionCard({
  title,
  description,
  action,
  children,
  testId,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-primary">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function VitalStat({
  label,
  value,
  unit,
  flag = "normal",
}: {
  label: string;
  value: string;
  unit: string;
  flag?: VitalFlag;
}) {
  return (
    <div className={cn("rounded-md border px-2.5 py-2", FLAG_SURFACE[flag])}>
      <p className="text-[11px] tracking-wide uppercase opacity-70">{label}</p>
      <p className={cn("mt-0.5 text-sm font-semibold tabular-nums", FLAG_TEXT[flag])}>
        {value}
        {unit ? <span className="ml-1 text-[11px] font-normal opacity-70">{unit}</span> : null}
      </p>
    </div>
  );
}

function ResultRow({ result }: { result: LabOrderItem["results"][number] }) {
  const abnormal = isAbnormalLabFlag(result.flag);
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-2 align-top text-xs">{result.parameter}</td>
      <td
        className={cn(
          "py-1.5 pr-2 align-top text-xs font-medium tabular-nums",
          abnormal ? "text-[var(--status-warning-foreground)] dark:text-[var(--status-warning)]" : "",
        )}
      >
        {result.value}
        {result.unit ? <span className="ml-1 font-normal opacity-70">{result.unit}</span> : null}
      </td>
      <td className="py-1.5 pr-2 align-top text-[11px] text-muted-foreground tabular-nums">
        {result.refRange ?? "—"}
      </td>
      <td className="py-1.5 align-top text-right">
        {abnormal ? (
          <Badge
            variant="outline"
            className={
              result.flag === "HH" || result.flag === "LL"
                ? "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
                : "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
            }
          >
            {LAB_RESULT_FLAG_LABELS[result.flag] ?? result.flag}
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">Normal</span>
        )}
      </td>
    </tr>
  );
}

export function DoctorWorkspace() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<QueueEntry | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restrictedAccess, setRestrictedAccess] = useState<{
    encounterId: string;
    message: string;
    privacy: NonNullable<Detail["privacy"]>;
  } | null>(null);
  const [accessReason, setAccessReason] = useState("");
  const [catalog, setCatalog] = useState<{ labTests: LabTestOption[]; drugs: DrugOption[] }>({
    labTests: [],
    drugs: [],
  });
  const [busy, setBusy] = useState<string | null>(null);

  const [soap, setSoap] = useState({
    subjective: "",
    objective: "",
    assessment: "",
    plan: "",
  });
  const [soapDirty, setSoapDirty] = useState(false);

  const [icdQuery, setIcdQuery] = useState("");
  const [icdResults, setIcdResults] = useState<Icd10Option[]>([]);
  const [icdLoading, setIcdLoading] = useState(false);
  const [selectedIcd, setSelectedIcd] = useState<Icd10Option | null>(null);
  const [icdPrimary, setIcdPrimary] = useState(false);

  const [labSelection, setLabSelection] = useState<string[]>([]);
  const [labNotes, setLabNotes] = useState("");

  const [rx, setRx] = useState({
    itemId: "",
    dose: "",
    route: "oral",
    frequency: "twice daily",
    durationDays: "5",
    quantity: "10",
    instructions: "",
  });

  const [outcome, setOutcome] = useState<DischargeOutcome>("discharged");
  const [outcomeNotes, setOutcomeNotes] = useState("");

  const keysRef = useRef<Record<string, string>>({});
  const selectedRef = useRef<QueueEntry | null>(null);
  const labDialogRef = useRef<HTMLDialogElement>(null);
  const rxDialogRef = useRef<HTMLDialogElement>(null);
  const outcomeDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  function keyFor(scope: string): string {
    if (!keysRef.current[scope]) keysRef.current[scope] = crypto.randomUUID();
    return keysRef.current[scope];
  }

  function clearKey(scope: string): void {
    delete keysRef.current[scope];
  }

  const loadDetail = useCallback(async (encounterId: string, reason?: string) => {
    setDetailLoading(true);
    try {
      const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
      const response = await fetch(`/api/doctor/encounter/${encounterId}${query}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | (Detail & { error?: string; code?: string; privacy?: Detail["privacy"] })
        | { error?: string; code?: string; privacy?: Detail["privacy"] }
        | null;
      if (!response.ok) {
        if (response.status === 403 && payload?.code === "chart_access_reason_required") {
          setDetail(null);
          setRestrictedAccess({
            encounterId,
            message:
              payload.error ?? "A reason is required to access this restricted patient chart",
            privacy: payload.privacy ?? { restricted: true, consentStatus: "restricted" },
          });
          setAccessReason("");
          return;
        }
        setDetail(null);
        setRestrictedAccess(null);
        return;
      }
      setRestrictedAccess(null);
      setAccessReason("");
      setDetail(payload as Detail);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/queue?department=Doctor", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { entries: QueueEntry[] };
      setEntries(data.entries);
      const current = selectedRef.current;
      if (current && !data.entries.some((entry) => entry.id === current.id)) {
        setSelected(null);
        setDetail(null);
        setRestrictedAccess(null);
        setAccessReason("");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshQueue();
    const interval = setInterval(() => void refreshQueue(), 30_000);
    const source = new EventSource("/api/events");
    const onQueue = () => void refreshQueue();
    const onClinical = () => {
      void refreshQueue();
      const current = selectedRef.current;
      if (current) void loadDetail(current.encounterId);
    };
    source.addEventListener("queue_changed", onQueue);
    source.addEventListener("queue_queued", onQueue);
    source.addEventListener("encounter_closed", onQueue);
    source.addEventListener("consultation_started", onQueue);
    source.addEventListener("clinical_note_saved", onClinical);
    source.addEventListener("diagnosis_recorded", onClinical);
    source.addEventListener("diagnosis_voided", onClinical);
    source.addEventListener("lab_order_created", onClinical);
    source.addEventListener("lab_order_cancelled", onClinical);
    source.addEventListener("lab_sample_collected", onClinical);
    source.addEventListener("lab_processing_started", onClinical);
    source.addEventListener("lab_results_entered", onClinical);
    source.addEventListener("lab_results_verified", onClinical);
    source.addEventListener("prescription_created", onClinical);
    source.addEventListener("prescription_cancelled", onClinical);
    source.addEventListener("prescription_dispensed", onClinical);
    source.addEventListener("prescription_reversed", onClinical);
    return () => {
      clearInterval(interval);
      source.removeEventListener("queue_changed", onQueue);
      source.removeEventListener("queue_queued", onQueue);
      source.removeEventListener("encounter_closed", onQueue);
      source.removeEventListener("consultation_started", onQueue);
      source.removeEventListener("clinical_note_saved", onClinical);
      source.removeEventListener("diagnosis_recorded", onClinical);
      source.removeEventListener("diagnosis_voided", onClinical);
      source.removeEventListener("lab_order_created", onClinical);
      source.removeEventListener("lab_order_cancelled", onClinical);
      source.removeEventListener("lab_sample_collected", onClinical);
      source.removeEventListener("lab_processing_started", onClinical);
      source.removeEventListener("lab_results_entered", onClinical);
      source.removeEventListener("lab_results_verified", onClinical);
      source.removeEventListener("prescription_created", onClinical);
      source.removeEventListener("prescription_cancelled", onClinical);
      source.removeEventListener("prescription_dispensed", onClinical);
      source.removeEventListener("prescription_reversed", onClinical);
      source.close();
    };
  }, [loadDetail, refreshQueue]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/doctor/catalog", { cache: "no-store" });
        if (!response.ok) return;
        setCatalog((await response.json()) as { labTests: LabTestOption[]; drugs: DrugOption[] });
      } catch {
        // Catalogue failure is non-fatal: dialogs show an empty list.
      }
    })();
  }, []);

  useEffect(() => {
    if (!detail || soapDirty) return;
    setSoap({
      subjective: detail.note?.subjective ?? "",
      objective: detail.note?.objective ?? "",
      assessment: detail.note?.assessment ?? "",
      plan: detail.note?.plan ?? "",
    });
  }, [detail, soapDirty]);

  useEffect(() => {
    const term = icdQuery.trim();
    if (term.length < 2) {
      setIcdResults([]);
      setIcdLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setIcdLoading(true);
      void (async () => {
        try {
          const response = await fetch(`/api/doctor/icd10?q=${encodeURIComponent(term)}`, {
            cache: "no-store",
          });
          if (!response.ok) return;
          const data = (await response.json()) as { codes: Icd10Option[] };
          if (!cancelled) setIcdResults(data.codes);
        } finally {
          if (!cancelled) setIcdLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [icdQuery]);

  async function selectPatient(entry: QueueEntry) {
    setSelected(entry);
    setDetail(null);
    setRestrictedAccess(null);
    setAccessReason("");
    setSoap({ subjective: "", objective: "", assessment: "", plan: "" });
    setSoapDirty(false);
    setSelectedIcd(null);
    setIcdQuery("");
    setIcdResults([]);
    setIcdPrimary(false);
    setDetailLoading(true);

    const scope = `consult:${entry.id}`;
    try {
      await postJson("/api/doctor/consultation", {
        encounterId: entry.encounterId,
        queueEntryId: entry.id,
        idempotencyKey: keyFor(scope),
      });
      clearKey(scope);
    } catch (error) {
      if (await handleSessionMismatch(error)) return;
      toast.error(error instanceof Error ? error.message : "Could not start the consultation");
      await refreshQueue();
      return;
    }
    await loadDetail(entry.encounterId);
  }

  async function runCommand(
    label: string,
    scope: string,
    action: () => Promise<unknown>,
    successMessage: string,
  ): Promise<boolean> {
    setBusy(label);
    try {
      await action();
      clearKey(scope);
      toast.success(successMessage);
      if (selectedRef.current) await loadDetail(selectedRef.current.encounterId);
      return true;
    } catch (error) {
      if (await handleSessionMismatch(error)) return false;
      toast.error(error instanceof Error ? error.message : "The request could not be completed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveNote(sign: boolean) {
    if (!selected) return;
    const encounterId = selected.encounterId;
    const scope = `note:${encounterId}`;
    await runCommand(
      sign ? "sign-note" : "save-note",
      scope,
      () =>
        postJson("/api/doctor/notes", {
          encounterId,
          idempotencyKey: keyFor(scope),
          ...soap,
          sign,
        }),
      sign ? "Clinical note signed and locked" : "Draft note saved",
    );
    setSoapDirty(false);
  }

  async function addDiagnosis() {
    if (!selected || !selectedIcd) return;
    const encounterId = selected.encounterId;
    const scope = `dx:${encounterId}:${selectedIcd.code}`;
    const ok = await runCommand(
      "add-diagnosis",
      scope,
      () =>
        postJson("/api/doctor/diagnoses", {
          encounterId,
          idempotencyKey: keyFor(scope),
          icd10Code: selectedIcd.code,
          isPrimary: icdPrimary,
        }),
      `${selectedIcd.code} recorded`,
    );
    if (ok) {
      setSelectedIcd(null);
      setIcdQuery("");
      setIcdResults([]);
      setIcdPrimary(false);
    }
  }

  async function removeDiagnosis(diagnosis: Diagnosis) {
    if (!selected) return;
    const encounterId = selected.encounterId;
    const scope = `void-dx:${diagnosis.id}`;
    await runCommand(
      `void-dx:${diagnosis.id}`,
      scope,
      () =>
        postJson("/api/doctor/diagnoses/void", {
          encounterId,
          idempotencyKey: keyFor(scope),
          diagnosisId: diagnosis.id,
        }),
      `${diagnosis.code} removed`,
    );
  }

  async function submitLabOrder() {
    if (!selected || labSelection.length === 0) return;
    const encounterId = selected.encounterId;
    const scope = `lab:${encounterId}`;
    const ok = await runCommand(
      "order-labs",
      scope,
      () =>
        postJson("/api/doctor/lab-orders", {
          encounterId,
          idempotencyKey: keyFor(scope),
          labTestIds: labSelection,
          clinicalNotes: labNotes || null,
        }),
      `${labSelection.length} test${labSelection.length === 1 ? "" : "s"} ordered`,
    );
    if (ok) {
      setLabSelection([]);
      setLabNotes("");
      labDialogRef.current?.close();
    }
  }

  async function cancelLab(order: LabOrder) {
    if (!selected) return;
    const encounterId = selected.encounterId;
    const scope = `cancel-lab:${order.id}`;
    await runCommand(
      `cancel-lab:${order.id}`,
      scope,
      () =>
        postJson("/api/doctor/lab-orders/cancel", {
          encounterId,
          idempotencyKey: keyFor(scope),
          labOrderId: order.id,
        }),
      "Laboratory order cancelled",
    );
  }

  async function submitPrescription() {
    if (!selected || !rx.itemId) return;
    const encounterId = selected.encounterId;
    const scope = `rx:${encounterId}`;
    const ok = await runCommand(
      "prescribe",
      scope,
      () =>
        postJson("/api/doctor/prescriptions", {
          encounterId,
          idempotencyKey: keyFor(scope),
          itemId: rx.itemId,
          dose: rx.dose,
          route: rx.route,
          frequency: rx.frequency,
          durationDays: rx.durationDays ? Number(rx.durationDays) : null,
          quantity: Number(rx.quantity),
          instructions: rx.instructions || null,
        }),
      "Prescription sent to pharmacy",
    );
    if (ok) {
      setRx({
        itemId: "",
        dose: "",
        route: "oral",
        frequency: "twice daily",
        durationDays: "5",
        quantity: "10",
        instructions: "",
      });
      rxDialogRef.current?.close();
    }
  }

  async function cancelPrescription(prescription: Prescription) {
    if (!selected) return;
    const encounterId = selected.encounterId;
    const scope = `cancel-rx:${prescription.id}`;
    await runCommand(
      `cancel-rx:${prescription.id}`,
      scope,
      () =>
        postJson("/api/doctor/prescriptions/cancel", {
          encounterId,
          idempotencyKey: keyFor(scope),
          prescriptionId: prescription.id,
        }),
      "Prescription cancelled",
    );
  }

  async function confirmOutcome() {
    if (!selected) return;
    const encounterId = selected.encounterId;
    const scope = `discharge:${encounterId}`;
    const ok = await runCommand(
      "discharge",
      scope,
      () =>
        postJson("/api/doctor/discharge", {
          encounterId,
          idempotencyKey: keyFor(scope),
          outcome,
          outcomeNotes: outcomeNotes || null,
        }),
      outcome === "referred" ? "Patient referred onward" : "Visit closed and patient discharged",
    );
    if (ok) {
      outcomeDialogRef.current?.close();
      setOutcomeNotes("");
      setSelected(null);
      setDetail(null);
      await refreshQueue();
    }
  }

  function openLabDialog() {
    setLabSelection([]);
    setLabNotes("");
    labDialogRef.current?.showModal();
  }

  function openRxDialog() {
    setRx({
      itemId: catalog.drugs[0]?.id ?? "",
      dose: "",
      route: "oral",
      frequency: "twice daily",
      durationDays: "5",
      quantity: "10",
      instructions: "",
    });
    rxDialogRef.current?.showModal();
  }

  function openOutcomeDialog(next: DischargeOutcome) {
    setOutcome(next);
    setOutcomeNotes("");
    outcomeDialogRef.current?.showModal();
  }

  const vitals = vitalsFromDetail(detail?.vitals ?? null);
  const noteSigned = Boolean(detail?.note?.signedAt);
  const outstandingLabs = detail
    ? detail.labOrders.filter((order) => ACTIVE_LAB_STATUSES.has(order.status))
    : [];

  const observationBlocks = detail?.vitals
    ? [
        {
          key: "bp",
          label: "Blood pressure",
          value:
            detail.vitals.systolic != null && detail.vitals.diastolic != null
              ? `${detail.vitals.systolic}/${detail.vitals.diastolic}`
              : "—",
          unit: "mmHg",
          flag: worstFlag([vitals.assessments.systolic?.flag, vitals.assessments.diastolic?.flag]),
        },
        ...(
          [
            "heartRate",
            "respRate",
            "temperature",
            "spo2",
            "weightKg",
            "heightCm",
            "bmi",
            "painScore",
          ] as MeasurementKey[]
        ).map((key) => ({
          key,
          label: VITAL_DEFINITIONS[key].label,
          value:
            detail.vitals?.[key] != null && detail.vitals[key] !== ""
              ? String(detail.vitals[key])
              : "—",
          unit: VITAL_DEFINITIONS[key].unit,
          flag: vitals.assessments[key]?.flag ?? "normal",
        })),
      ]
    : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)]">
      <section
        data-testid="doctor-live-queue"
        className="self-start overflow-hidden rounded-lg border border-border bg-card lg:sticky lg:top-4"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-primary">Doctor queue</h2>
            <p className="text-xs text-muted-foreground">Priority order, then arrival time</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{entries.length}</Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refreshQueue()}
              aria-label="Refresh doctor queue"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading doctor queue…</p>
        ) : entries.length === 0 ? (
          <div data-testid="doctor-queue-empty" className="px-4 py-8 text-sm text-muted-foreground">
            <Stethoscope className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            No patients waiting for a doctor.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => {
              const active = selected?.id === entry.id;
              return (
                <li key={entry.id} data-testid={`queue-row-${entry.id}`}>
                  <button
                    type="button"
                    onClick={() => void selectPatient(entry)}
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
                      <span className="text-[11px] text-muted-foreground">
                        {entry.allergies.length > 0 ? (
                          <span className="inline-flex items-center gap-1 text-[var(--status-critical-foreground)] dark:text-[var(--status-critical)]">
                            <AlertTriangle className="size-3" aria-hidden="true" />
                            Allergy
                          </span>
                        ) : (
                          formatDateTime(entry.queuedAt)
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="space-y-6">
        {!selected ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <div
              data-testid="doctor-no-selection"
              className="flex min-h-72 flex-col items-center justify-center rounded-md border border-dashed border-border bg-secondary/40 px-6 py-10 text-center"
            >
              <UserRound className="size-7 text-muted-foreground" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">Select a patient to begin the consultation</p>
              <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                Their triage observations appear here. Record SOAP notes, code diagnoses, order
                laboratory tests, prescribe treatment and close the visit.
              </p>
            </div>
          </section>
        ) : (
          <>
            <section
              data-testid="doctor-patient-banner"
              className="sticky top-0 z-20 rounded-lg border border-border bg-card px-4 py-3 shadow-sm"
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
                <div className="flex flex-wrap items-center gap-2">
                  {detail?.vitals ? (
                    <Badge
                      variant="outline"
                      className={CATEGORY_STYLES[detail.vitals.category as TriageCategory]}
                    >
                      Triage:{" "}
                      {TRIAGE_CATEGORY_LABELS[detail.vitals.category as TriageCategory]}
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="capitalize">
                    {selected.payerType}
                  </Badge>
                  {(() => {
                    const privacy =
                      detail?.privacy ??
                      (restrictedAccess?.encounterId === selected.encounterId
                        ? restrictedAccess.privacy
                        : null);
                    if (!privacy) return null;
                    const label =
                      privacy.consentStatus === "restricted"
                        ? "Consent: Restricted"
                        : privacy.consentStatus === "current"
                          ? "Consent: current"
                          : "Consent: missing";
                    const style =
                      privacy.consentStatus === "restricted"
                        ? "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
                        : privacy.consentStatus === "current"
                          ? "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                          : "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]";
                    return (
                      <Badge
                        variant="outline"
                        data-testid="doctor-consent-status"
                        className={cn("font-medium", style)}
                      >
                        {label}
                      </Badge>
                    );
                  })()}
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
                  <dt className="text-muted-foreground">Blood group</dt>
                  <dd className="font-medium">{detail?.patient.bloodGroup ?? "—"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Allergies</dt>
                  <dd
                    className={cn(
                      "font-medium",
                      selected.allergies.length > 0 &&
                        "text-[var(--status-critical-foreground)] dark:text-[var(--status-critical)]",
                    )}
                  >
                    {selected.allergies.length > 0
                      ? selected.allergies.join(", ")
                      : "None recorded"}
                  </dd>
                </div>
              </dl>
              {detail?.vitals ? (
                <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Chief complaint: </span>
                  {detail.vitals.chiefComplaint}
                </p>
              ) : null}
            </section>

            {detailLoading && !detail ? (
              <p className="px-1 text-sm text-muted-foreground">Loading consultation…</p>
            ) : null}

            {restrictedAccess?.encounterId === selected.encounterId && !detail ? (
              <SectionCard
                title="Restricted chart access"
                description={restrictedAccess.message}
                testId="doctor-restricted-access"
              >
                <form
                  className="flex flex-col gap-3 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const reason = accessReason.trim();
                    if (!reason) return;
                    void loadDetail(selected.encounterId, reason);
                  }}
                >
                  <div className="flex-1">
                    <Label htmlFor="doctor-access-reason">Reason for access</Label>
                    <Input
                      id="doctor-access-reason"
                      data-testid="doctor-access-reason"
                      value={accessReason}
                      onChange={(event) => setAccessReason(event.target.value)}
                      placeholder="e.g. Treating clinician – ongoing care"
                      required
                      autoComplete="off"
                    />
                  </div>
                  <Button type="submit" data-testid="doctor-access-reason-submit">
                    Continue
                  </Button>
                </form>
                <p className="mt-2 text-xs text-muted-foreground">
                  Access to restricted charts is recorded with your reason.
                </p>
              </SectionCard>
            ) : null}

            {detail?.vitals ? (
              <SectionCard
                title="Triage observations"
                description={`Recorded ${formatDateTime(detail.vitals.createdAt)}`}
                testId="doctor-triage-summary"
              >
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                  {observationBlocks.map((block) => (
                    <VitalStat
                      key={block.key}
                      label={block.label}
                      value={block.value}
                      unit={block.unit}
                      flag={block.flag}
                    />
                  ))}
                </div>
                {detail.vitals.comments ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Triage comments: </span>
                    {detail.vitals.comments}
                  </p>
                ) : null}
                {detail.vitals.nextSteps ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Next steps: </span>
                    {detail.vitals.nextSteps}
                  </p>
                ) : null}
              </SectionCard>
            ) : null}

            <SectionCard
              title="Clinical note"
              description="Subjective, objective, assessment and plan. Signing locks the note."
              testId="doctor-soap"
              action={
                noteSigned ? (
                  <Badge
                    variant="outline"
                    className="border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                  >
                    <Lock className="size-3" aria-hidden="true" /> Signed
                  </Badge>
                ) : (
                  <Badge variant="outline">Draft</Badge>
                )
              }
            >
              {noteSigned ? (
                <div className="space-y-3">
                  {SOAP_SECTIONS.map((section) => (
                    <div key={section.key}>
                      <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                        {section.label}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm">
                        {detail?.note?.[section.key]?.trim() || "—"}
                      </p>
                    </div>
                  ))}
                  <p className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-2 text-xs text-muted-foreground">
                    <Lock className="size-3.5" aria-hidden="true" />
                    {CLINICAL_NOTE_LOCKED_MESSAGE}. Signed {formatDateTime(detail?.note?.signedAt ?? null)}.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {SOAP_SECTIONS.map((section) => (
                    <div key={section.key}>
                      <Label htmlFor={`soap-${section.key}`} className="flex-col items-start gap-0.5">
                        <span>{section.label}</span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {section.hint}
                        </span>
                      </Label>
                      <textarea
                        id={`soap-${section.key}`}
                        data-testid={`soap-${section.key}`}
                        value={soap[section.key]}
                        onChange={(event) => {
                          setSoap((current) => ({ ...current, [section.key]: event.target.value }));
                          setSoapDirty(true);
                        }}
                        rows={section.key === "subjective" || section.key === "objective" ? 3 : 4}
                        className={cn(TEXTAREA_CLASS, "mt-1 resize-y")}
                        placeholder={`Write the ${section.label.toLowerCase()} section…`}
                      />
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      data-testid="save-note"
                      disabled={busy === "save-note"}
                      onClick={() => void saveNote(false)}
                    >
                      <FileText aria-hidden="true" />
                      {busy === "save-note" ? "Saving…" : "Save draft"}
                    </Button>
                    <Button
                      type="button"
                      data-testid="sign-note"
                      disabled={busy === "sign-note"}
                      onClick={() => void saveNote(true)}
                    >
                      <CheckCircle2 aria-hidden="true" />
                      {busy === "sign-note" ? "Signing…" : "Sign note"}
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      Assessment and plan are required to sign.
                    </span>
                  </div>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Diagnoses"
              description="ICD-10 coded problems for this visit. One primary diagnosis at a time."
              testId="doctor-diagnoses"
            >
              <div className="space-y-2">
                {detail?.diagnoses.length ? (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {detail.diagnoses.map((diagnosis) => (
                      <li
                        key={diagnosis.id}
                        data-testid={`diagnosis-row-${diagnosis.code}`}
                        className="flex items-start justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            <span className="font-mono">{diagnosis.code}</span>
                            <span className="text-muted-foreground">{diagnosis.description}</span>
                            {diagnosis.isPrimary ? (
                              <Badge variant="secondary">Primary</Badge>
                            ) : null}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            Recorded {formatDateTime(diagnosis.createdAt)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${diagnosis.code}`}
                          data-testid={`void-diagnosis-${diagnosis.code}`}
                          disabled={busy === `void-dx:${diagnosis.id}`}
                          onClick={() => void removeDiagnosis(diagnosis)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote>No diagnoses recorded yet.</EmptyNote>
                )}
              </div>

              <div className="mt-4 rounded-md border border-border bg-secondary/40 p-3">
                <Label htmlFor="icd10-search">Add a diagnosis</Label>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Input
                    id="icd10-search"
                    data-testid="icd10-search"
                    value={icdQuery}
                    onChange={(event) => {
                      setIcdQuery(event.target.value);
                      setSelectedIcd(null);
                    }}
                    placeholder="Search ICD-10 code or description…"
                    autoComplete="off"
                    className="min-w-48 flex-1"
                  />
                  <Button
                    type="button"
                    data-testid="add-diagnosis"
                    disabled={!selectedIcd || busy === "add-diagnosis"}
                    onClick={() => void addDiagnosis()}
                  >
                    <Plus aria-hidden="true" />
                    {busy === "add-diagnosis" ? "Adding…" : "Add"}
                  </Button>
                </div>

                {icdLoading ? (
                  <p className="mt-2 text-xs text-muted-foreground">Searching…</p>
                ) : null}

                {selectedIcd ? (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--status-normal)] bg-[var(--status-normal-background)] px-2.5 py-2 text-xs text-[var(--status-normal-foreground)]">
                    <span>
                      <span className="font-mono font-semibold">{selectedIcd.code}</span> ·{" "}
                      {selectedIcd.description}
                    </span>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        data-testid="icd10-primary"
                        checked={icdPrimary}
                        onChange={(event) => setIcdPrimary(event.target.checked)}
                        className="size-3.5 accent-[var(--primary)]"
                      />
                      Primary
                    </label>
                  </div>
                ) : icdResults.length > 0 ? (
                  <ul className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border bg-card">
                    {icdResults.map((option) => (
                      <li key={option.code}>
                        <button
                          type="button"
                          data-testid={`icd10-result-${option.code}`}
                          onClick={() => {
                            setSelectedIcd(option);
                            setIcdQuery(`${option.code} — ${option.description}`);
                            setIcdResults([]);
                          }}
                          className="flex w-full items-start gap-2 px-2.5 py-2 text-left text-xs hover:bg-secondary"
                        >
                          <span className="font-mono font-semibold">{option.code}</span>
                          <span className="text-muted-foreground">{option.description}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : icdQuery.trim().length >= 2 && !selectedIcd ? (
                  <p className="mt-2 text-xs text-muted-foreground">No matching ICD-10 codes.</p>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard
              title="Laboratory orders"
              description="Results appear here as soon as the laboratory verifies them."
              testId="doctor-lab-orders"
              action={
                <Button type="button" size="sm" data-testid="order-lab-tests" onClick={openLabDialog}>
                  <FlaskConical aria-hidden="true" />
                  Order tests
                </Button>
              }
            >
              {detail?.labOrders.length ? (
                <ul className="space-y-3">
                  {detail.labOrders.map((order) => (
                    <li
                      key={order.id}
                      data-testid={`lab-order-${order.id}`}
                      className="rounded-md border border-border"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={LAB_STATUS_STYLES[order.status]}>
                            {LAB_STATUS_LABELS[order.status] ?? order.status}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            Ordered {formatDateTime(order.createdAt)}
                          </span>
                        </div>
                        {canCancelLabOrder(order.status as never) ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`cancel-lab-order-${order.id}`}
                            disabled={busy === `cancel-lab:${order.id}`}
                            onClick={() => void cancelLab(order)}
                          >
                            Cancel order
                          </Button>
                        ) : null}
                      </div>
                      {order.clinicalNotes ? (
                        <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                          {order.clinicalNotes}
                        </p>
                      ) : null}
                      <ul className="divide-y divide-border">
                        {order.items.map((item) => (
                          <li key={item.id} className="px-3 py-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-medium">
                                {item.testName}{" "}
                                <span className="font-mono text-[11px] text-muted-foreground">
                                  {item.testCode}
                                </span>
                              </p>
                              <span className="text-[11px] text-muted-foreground">
                                {LAB_STATUS_LABELS[item.status] ?? item.status}
                              </span>
                            </div>
                            {item.results.length > 0 ? (
                              <table className="mt-1.5 w-full border-collapse">
                                <thead>
                                  <tr className="text-[10px] tracking-wide text-muted-foreground uppercase">
                                    <th className="pb-1 text-left font-medium">Parameter</th>
                                    <th className="pb-1 text-left font-medium">Value</th>
                                    <th className="pb-1 text-left font-medium">Reference</th>
                                    <th className="pb-1 text-right font-medium">Flag</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.results.map((result) => (
                                    <ResultRow key={result.id} result={result} />
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                Awaiting result.
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyNote>No laboratory tests ordered for this visit.</EmptyNote>
              )}
            </SectionCard>

            <SectionCard
              title="Prescriptions"
              description="Medicines are dispensed by the pharmacy from live stock."
              testId="doctor-prescriptions"
              action={
                <Button type="button" size="sm" data-testid="prescribe-medicine" onClick={openRxDialog}>
                  <Pill aria-hidden="true" />
                  Prescribe
                </Button>
              }
            >
              {detail?.prescriptions.length ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {detail.prescriptions.map((prescription) => (
                    <li
                      key={prescription.id}
                      data-testid={`prescription-${prescription.id}`}
                      className="flex flex-wrap items-start justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {prescription.itemName}
                          {prescription.strength ? (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              {prescription.strength}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {prescription.dose} · {prescription.route} · {prescription.frequency}
                          {prescription.durationDays ? ` · ${prescription.durationDays} days` : ""} ·{" "}
                          qty {prescription.quantity}
                        </p>
                        {prescription.instructions ? (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {prescription.instructions}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={PRESCRIPTION_STATUS_STYLES[prescription.status]}
                        >
                          {prescription.status}
                        </Badge>
                        {canCancelPrescription(prescription.status as never) ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid={`cancel-prescription-${prescription.id}`}
                            disabled={busy === `cancel-rx:${prescription.id}`}
                            onClick={() => void cancelPrescription(prescription)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyNote>No medicines prescribed for this visit.</EmptyNote>
              )}
            </SectionCard>

            <SectionCard
              title="Visit history"
              description="Previous closed visits for this patient."
              testId="doctor-history"
            >
              {detail?.history.length ? (
                <ul className="space-y-3">
                  {detail.history.map((entry) => (
                    <li key={entry.id} className="rounded-md border border-border px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-mono text-xs font-medium">{entry.encounterNo}</p>
                        <span className="text-[11px] text-muted-foreground">
                          {formatDate(entry.startedAt)} · {entry.status}
                        </span>
                      </div>
                      {entry.diagnoses.length > 0 ? (
                        <p className="mt-1 text-xs">
                          {entry.diagnoses.map((diagnosis) => (
                            <span key={diagnosis.code} className="mr-2 inline-block">
                              <span className="font-mono font-medium">{diagnosis.code}</span>{" "}
                              <span className="text-muted-foreground">{diagnosis.description}</span>
                            </span>
                          ))}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">No coded diagnosis.</p>
                      )}
                      {entry.assessment ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground">Assessment: </span>
                          {entry.assessment}
                        </p>
                      ) : null}
                      {entry.plan ? (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground">Plan: </span>
                          {entry.plan}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyNote>No previous visits recorded for this patient.</EmptyNote>
              )}
            </SectionCard>

            <SectionCard
              title="Close the visit"
              description="Discharge the patient home or refer them onward."
              testId="doctor-outcome"
            >
              {outstandingLabs.length > 0 ? (
                <p className="mb-3 flex items-start gap-2 rounded-md border border-[var(--status-warning)] bg-[var(--status-warning-background)] px-2.5 py-2 text-xs text-[var(--status-warning-foreground)]">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {outstandingLabs.length} laboratory order
                  {outstandingLabs.length === 1 ? " is" : "s are"} still outstanding. Resolve or cancel
                  them before closing the visit.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  data-testid="discharge-visit"
                  disabled={outstandingLabs.length > 0}
                  onClick={() => openOutcomeDialog("discharged")}
                >
                  <CheckCircle2 aria-hidden="true" />
                  {DISCHARGE_OUTCOME_LABELS.discharged}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="refer-visit"
                  disabled={outstandingLabs.length > 0}
                  onClick={() => openOutcomeDialog("referred")}
                >
                  <ClipboardList aria-hidden="true" />
                  {DISCHARGE_OUTCOME_LABELS.referred}
                </Button>
              </div>
            </SectionCard>
          </>
        )}
      </div>

      {/* Laboratory order dialog */}
      <dialog
        ref={labDialogRef}
        aria-labelledby="lab-dialog-title"
        className="w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="lab-dialog-title" className="text-sm font-semibold text-primary">
            Order laboratory tests
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close laboratory order dialog"
            onClick={() => labDialogRef.current?.close()}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {catalog.labTests.length === 0 ? (
            <EmptyNote>No laboratory tests are configured.</EmptyNote>
          ) : (
            <ul className="space-y-1">
              {catalog.labTests.map((test) => (
                <li key={test.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary">
                    <input
                      type="checkbox"
                      data-testid={`lab-test-option-${test.code}`}
                      checked={labSelection.includes(test.id)}
                      onChange={(event) =>
                        setLabSelection((current) =>
                          event.target.checked
                            ? [...current, test.id]
                            : current.filter((id) => id !== test.id),
                        )
                      }
                      className="mt-0.5 size-3.5 accent-[var(--primary)]"
                    />
                    <span>
                      <span className="font-medium">{test.name}</span>
                      <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                        {test.code}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {test.sampleType} · {test.parameters.length} parameter
                        {test.parameters.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <Label htmlFor="lab-clinical-notes">Clinical notes (optional)</Label>
            <textarea
              id="lab-clinical-notes"
              data-testid="lab-clinical-notes"
              value={labNotes}
              onChange={(event) => setLabNotes(event.target.value)}
              rows={2}
              className={cn(TEXTAREA_CLASS, "mt-1 resize-y")}
              placeholder="Reason for the request or specific questions for the laboratory…"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="outline" onClick={() => labDialogRef.current?.close()}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="submit-lab-order"
            disabled={labSelection.length === 0 || busy === "order-labs"}
            onClick={() => void submitLabOrder()}
          >
            <FlaskConical aria-hidden="true" />
            {busy === "order-labs"
              ? "Ordering…"
              : `Order ${labSelection.length || ""} test${labSelection.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </dialog>

      {/* Prescription dialog */}
      <dialog
        ref={rxDialogRef}
        aria-labelledby="rx-dialog-title"
        className="w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="rx-dialog-title" className="text-sm font-semibold text-primary">
            Prescribe a medicine
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close prescription dialog"
            onClick={() => rxDialogRef.current?.close()}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
          <div>
            <Label htmlFor="rx-item">Medicine</Label>
            <select
              id="rx-item"
              data-testid="rx-item"
              value={rx.itemId}
              onChange={(event) => setRx((current) => ({ ...current, itemId: event.target.value }))}
              className={cn(SELECT_CLASS, "mt-1")}
            >
              <option value="">Select a medicine…</option>
              {catalog.drugs.map((drug) => (
                <option key={drug.id} value={drug.id}>
                  {drug.name}
                  {drug.strength ? ` — ${drug.strength}` : ""}
                  {drug.form ? ` (${drug.form})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="rx-dose">Dose</Label>
              <Input
                id="rx-dose"
                data-testid="rx-dose"
                value={rx.dose}
                onChange={(event) => setRx((current) => ({ ...current, dose: event.target.value }))}
                placeholder="e.g. 1 tablet, 5 mL"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="rx-quantity">Quantity</Label>
              <Input
                id="rx-quantity"
                data-testid="rx-quantity"
                type="number"
                min={1}
                max={1000}
                value={rx.quantity}
                onChange={(event) =>
                  setRx((current) => ({ ...current, quantity: event.target.value }))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="rx-route">Route</Label>
              <select
                id="rx-route"
                data-testid="rx-route"
                value={rx.route}
                onChange={(event) => setRx((current) => ({ ...current, route: event.target.value }))}
                className={cn(SELECT_CLASS, "mt-1")}
              >
                {PRESCRIPTION_ROUTES.map((route) => (
                  <option key={route} value={route}>
                    {route}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="rx-frequency">Frequency</Label>
              <select
                id="rx-frequency"
                data-testid="rx-frequency"
                value={rx.frequency}
                onChange={(event) =>
                  setRx((current) => ({ ...current, frequency: event.target.value }))
                }
                className={cn(SELECT_CLASS, "mt-1")}
              >
                {PRESCRIPTION_FREQUENCIES.map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {frequency}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="rx-duration">Duration (days)</Label>
              <Input
                id="rx-duration"
                data-testid="rx-duration"
                type="number"
                min={1}
                max={365}
                value={rx.durationDays}
                onChange={(event) =>
                  setRx((current) => ({ ...current, durationDays: event.target.value }))
                }
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="rx-instructions">Instructions (optional)</Label>
            <textarea
              id="rx-instructions"
              data-testid="rx-instructions"
              value={rx.instructions}
              onChange={(event) =>
                setRx((current) => ({ ...current, instructions: event.target.value }))
              }
              rows={2}
              className={cn(TEXTAREA_CLASS, "mt-1 resize-y")}
              placeholder="e.g. Take after food"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="outline" onClick={() => rxDialogRef.current?.close()}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="submit-prescription"
            disabled={!rx.itemId || !rx.dose.trim() || !rx.quantity || busy === "prescribe"}
            onClick={() => void submitPrescription()}
          >
            <Pill aria-hidden="true" />
            {busy === "prescribe" ? "Prescribing…" : "Prescribe"}
          </Button>
        </div>
      </dialog>

      {/* Discharge / refer dialog */}
      <dialog
        ref={outcomeDialogRef}
        aria-labelledby="outcome-dialog-title"
        className="w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="outcome-dialog-title" className="text-sm font-semibold text-primary">
            {DISCHARGE_OUTCOME_LABELS[outcome]}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close outcome dialog"
            onClick={() => outcomeDialogRef.current?.close()}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">
            This closes the visit and removes the patient from the doctor queue.
          </p>
          <div>
            <Label htmlFor="outcome-notes">Outcome notes (optional)</Label>
            <textarea
              id="outcome-notes"
              data-testid="outcome-notes"
              value={outcomeNotes}
              onChange={(event) => setOutcomeNotes(event.target.value)}
              rows={3}
              className={cn(TEXTAREA_CLASS, "mt-1 resize-y")}
              placeholder="Follow-up instructions or referral destination…"
            />
          </div>
          {DISCHARGE_OUTCOMES.length > 1 ? (
            <p className="text-[11px] text-muted-foreground">
              Outcome recorded: <span className="font-medium text-foreground">{outcome}</span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="outline" onClick={() => outcomeDialogRef.current?.close()}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="confirm-outcome"
            disabled={busy === "discharge"}
            onClick={() => void confirmOutcome()}
          >
            <CheckCircle2 aria-hidden="true" />
            {busy === "discharge" ? "Closing…" : "Confirm"}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
