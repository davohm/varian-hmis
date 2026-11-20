"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  BREACH_SEVERITIES,
  CONSENT_TYPES,
  DSAR_TYPES,
  SHARING_COUNTERPARTY_TYPES,
  type BreachSeverity,
  type ConsentType,
  type DataSubjectRequestStatus,
  type DataSubjectRequestType,
} from "@/lib/privacy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingPanel } from "@/components/ui/loading-panel";
import { cn } from "cn";

import { DataTable, Panel, requestJson } from "./admin-workspace";

interface ConsentRow {
  id: string;
  patientId: string;
  patientName: string | null;
  patientMrn: string | null;
  consentType: string;
  consentVersion: string;
  granted: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  source: string | null;
  createdAt: string;
  isValid: boolean;
}

interface RequestRow {
  id: string;
  requestNo: string;
  requestType: DataSubjectRequestType;
  status: DataSubjectRequestStatus;
  subjectName: string;
  subjectContact: string | null;
  subjectIdType: string | null;
  subjectIdNumber: string | null;
  patientId: string | null;
  patientName: string | null;
  patientMrn: string | null;
  receivedAt: string;
  dueAt: string;
  completedAt: string | null;
  outcome: string | null;
  isOverdue: boolean;
}

interface BreachRow {
  id: string;
  severity: BreachSeverity;
  status: string;
  description: string;
  affectedCount: number | null;
  dataCategories: string[];
  subjectTypes: string[];
  detectedAt: string;
  odpcNotifiedAt: string | null;
  subjectNotifiedAt: string | null;
  odpcDeadline: string;
  odpcNotified: boolean;
  subjectNotified: boolean;
  overdueOdpcNotification: boolean;
  overdueSubjectNotification: boolean;
}

interface RetentionRow {
  id: string;
  entity: string;
  triggerEvent: string;
  retentionYears: number;
  destroyAfter: string | null;
  legalHold: boolean;
  holdReason: string | null;
  reviewAt: string | null;
  updatedAt: string;
}

interface SharingAgreementRow {
  id: string;
  counterpartyName: string;
  counterpartyType: string;
  purpose: string;
  status: string;
  signedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  documentHash: string | null;
  notes: string | null;
  updatedAt: string;
}

interface TransferRow {
  id: string;
  destinationCountry: string;
  legalBasis: string;
  safeguards: string | null;
  dataCategories: string[];
  riskLevel: string | null;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  reviewAt: string | null;
  createdAt: string;
}

interface AccessLogRow {
  id: string;
  patientId: string;
  encounterId: string | null;
  userId: string;
  userName: string | null;
  reason: string;
  isBreakGlass: boolean;
  accessedAt: string;
}

interface PrivacyPayload {
  facilityId: string;
  consents: ConsentRow[];
  requests: RequestRow[];
  overdueRequests: RequestRow[];
  breaches: BreachRow[];
  overdueBreaches: BreachRow[];
  retentionDue: RetentionRow[];
  sharingAgreements: SharingAgreementRow[];
  transfers: TransferRow[];
  accessLog: AccessLogRow[];
}

const TABS = [
  { id: "consents", label: "Consents" },
  { id: "requests", label: "Requests" },
  { id: "breaches", label: "Breaches" },
  { id: "retention", label: "Retention" },
  { id: "sharing", label: "Sharing" },
  { id: "transfers", label: "Transfers" },
  { id: "access", label: "Access log" },
] as const;

type TabId = (typeof TABS)[number]["id"];

async function postPrivacyCommand(command: string, input: Record<string, unknown>) {
  return requestJson<{ result: unknown }>("/api/admin/privacy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "admin-station" },
    body: JSON.stringify({
      command,
      input: { ...input, idempotencyKey: crypto.randomUUID() },
    }),
  });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString("en-KE", { dateStyle: "medium" });
}

function StatusPill({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  children: ReactNode;
}) {
  const cls =
    tone === "good"
      ? "border-[var(--status-normal)]/30 bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
      : tone === "warn"
        ? "border-[var(--status-warning)]/30 bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
        : tone === "bad"
          ? "border-[var(--status-critical)]/30 bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
          : "border-border bg-muted text-muted-foreground";
  return (
    <span className={cn("inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold", cls)}>
      {children}
    </span>
  );
}

function useCountdown(deadlineIso: string | null, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !deadlineIso) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [deadlineIso, running]);
  if (!deadlineIso) return null;
  const ms = new Date(deadlineIso).getTime() - now;
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return { overdue, hours, minutes, label: `${hours}h ${minutes}m` };
}

function BreachClock({ breach }: { breach: BreachRow }) {
  const odpc = useCountdown(breach.odpcDeadline, !breach.odpcNotified);
  const subjectRequired = breach.severity === "high" || breach.severity === "critical";
  return (
    <div className="space-y-1 text-xs" aria-label="Breach notification clocks">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">ODPC (72h):</span>
        {breach.odpcNotified ? (
          <StatusPill tone="good">Notified {formatDateTime(breach.odpcNotifiedAt)}</StatusPill>
        ) : odpc ? (
          <StatusPill tone={odpc.overdue ? "bad" : "warn"}>
            {odpc.overdue ? `Overdue by ${odpc.label}` : `${odpc.label} remaining`}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">—</StatusPill>
        )}
        <span className="text-muted-foreground">deadline {formatDateTime(breach.odpcDeadline)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Data subjects:</span>
        {!subjectRequired ? (
          <StatusPill tone="neutral">Assess and notify as practicable if required</StatusPill>
        ) : breach.subjectNotified ? (
          <StatusPill tone="good">Notified {formatDateTime(breach.subjectNotifiedAt)}</StatusPill>
        ) : (
          <StatusPill tone="warn">As soon as practicable (high/critical risk)</StatusPill>
        )}
      </div>
      {(breach.overdueOdpcNotification || breach.overdueSubjectNotification) && (
        <p className="text-[var(--status-critical-foreground)] font-medium" role="alert">
          Notification overdue — action required.
        </p>
      )}
    </div>
  );
}

function FieldRow({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PrivacyPanel() {
  const [data, setData] = useState<PrivacyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("consents");

  const load = useCallback(async () => {
    try {
      setData(await requestJson<PrivacyPayload>("/api/admin/privacy"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load privacy data");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (label: string, command: string, input: Record<string, unknown>, success: string) => {
      setBusy(label);
      try {
        await postPrivacyCommand(command, input);
        await load();
        toast.success(success);
        return true;
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "The request could not be completed");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (error) {
    return (
      <Panel title="Privacy" description={error} testId="privacy-error">
        <Button size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </Panel>
    );
  }
  if (!data) return <LoadingPanel label="Loading privacy workspace" />;

  return (
    <div className="space-y-4" data-testid="privacy-panel">
      <Panel
        title="Data protection"
        description="Manage consents, data-subject requests, breaches, retention, sharing agreements, cross-border transfers and chart access. Actions are audited."
        testId="privacy-summary"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Overdue requests</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{data.overdueRequests.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Overdue breach notifications</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{data.overdueBreaches.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Retention due</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{data.retentionDue.length}</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Chart access entries</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{data.accessLog.length}</p>
          </div>
        </div>
      </Panel>

      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Privacy sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`privacy-tab-${item.id}`}
            onClick={() => setTab(item.id)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === item.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "consents" ? <ConsentsTab data={data} busy={busy} run={run} /> : null}
      {tab === "requests" ? <RequestsTab data={data} busy={busy} run={run} /> : null}
      {tab === "breaches" ? <BreachesTab data={data} busy={busy} run={run} /> : null}
      {tab === "retention" ? <RetentionTab data={data} busy={busy} run={run} /> : null}
      {tab === "sharing" ? <SharingTab data={data} busy={busy} run={run} /> : null}
      {tab === "transfers" ? <TransfersTab data={data} busy={busy} run={run} /> : null}
      {tab === "access" ? <AccessLogTab data={data} /> : null}
    </div>
  );
}

type RunFn = (label: string, command: string, input: Record<string, unknown>, success: string) => Promise<boolean>;

function ConsentsTab({ data, busy, run }: { data: PrivacyPayload; busy: string | null; run: RunFn }) {
  const [form, setForm] = useState({
    patientId: "",
    consentType: "treatment" as ConsentType,
    consentVersion: "v1",
    consentText: "",
    granted: "true",
    source: "admin",
    validTo: "",
  });
  const [withdraw, setWithdraw] = useState({ consentId: "", reason: "" });
  const [exportId, setExportId] = useState("");
  const [exporting, setExporting] = useState(false);

  async function hashText(text: string): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const bytes = new TextEncoder().encode(trimmed);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function submitRecord(e: React.FormEvent) {
    e.preventDefault();
    const consentTextHash = await hashText(form.consentText);
    await run(
      "recordConsent",
      "recordConsent",
      {
        patientId: form.patientId.trim(),
        consentType: form.consentType,
        consentVersion: form.consentVersion.trim(),
        granted: form.granted === "true",
        consentTextHash,
        source: form.source.trim() || undefined,
        validTo: form.validTo ? new Date(form.validTo).toISOString() : undefined,
      },
      "Consent recorded.",
    );
  }

  async function submitWithdraw(e: React.FormEvent) {
    e.preventDefault();
    await run(
      "withdrawConsent",
      "withdrawConsent",
      { consentId: withdraw.consentId.trim(), reason: withdraw.reason.trim() || undefined },
      "Consent withdrawn.",
    );
  }

  async function submitExport(e: React.FormEvent) {
    e.preventDefault();
    setExporting(true);
    try {
      const res = await postPrivacyCommand("exportPatientData", { patientId: exportId.trim() });
      const blob = new Blob([JSON.stringify(res.result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `patient-export-${exportId.trim()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Patient data export downloaded.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not export patient data");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel title="Consents" description="Versioned, purpose-specific consents. Superseded or withdrawn records are not valid for sharing." testId="privacy-consents">
        <DataTable
          rows={data.consents}
          testId="privacy-consents-table"
          empty="No consent records."
          columns={[
            {
              key: "patient",
              label: "Patient",
              render: (row) => (
                <div>
                  <div className="font-medium">{row.patientName ?? row.patientId.slice(0, 8)}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{row.patientMrn ?? row.patientId}</div>
                </div>
              ),
            },
            { key: "type", label: "Type", render: (row) => row.consentType },
            { key: "version", label: "Version", render: (row) => row.consentVersion },
            {
              key: "status",
              label: "Status",
              render: (row) =>
                row.isValid ? (
                  <StatusPill tone="good">{row.granted ? "Granted & current" : "Refused (current)"}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">{row.withdrawnAt ? "Withdrawn" : row.granted ? "Superseded/expired" : "Refused"}</StatusPill>
                ),
            },
            { key: "when", label: "Recorded", render: (row) => formatDateTime(row.createdAt) },
          ]}
        />
      </Panel>

      <div className="space-y-4">
        <Panel title="Record consent" description="Consent text is hashed (SHA-256) before storage; the raw text is not stored by this action." testId="privacy-consent-form">
          <form className="space-y-3" onSubmit={submitRecord}>
            <FieldRow label="Patient ID" htmlFor="consent-patient">
              <Input id="consent-patient" value={form.patientId} onChange={(e) => setForm((f) => ({ ...f, patientId: e.target.value }))} required placeholder="Patient UUID" data-testid="privacy-consent-patient" />
            </FieldRow>
            <FieldRow label="Consent type" htmlFor="consent-type">
              <select id="consent-type" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.consentType} onChange={(e) => setForm((f) => ({ ...f, consentType: e.target.value as ConsentType }))} data-testid="privacy-consent-type">
                {CONSENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </FieldRow>
            <div className="grid grid-cols-2 gap-2">
              <FieldRow label="Version" htmlFor="consent-version">
                <Input id="consent-version" value={form.consentVersion} onChange={(e) => setForm((f) => ({ ...f, consentVersion: e.target.value }))} required data-testid="privacy-consent-version" />
              </FieldRow>
              <FieldRow label="Granted" htmlFor="consent-granted">
                <select id="consent-granted" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.granted} onChange={(e) => setForm((f) => ({ ...f, granted: e.target.value }))}>
                  <option value="true">Granted</option>
                  <option value="false">Refused</option>
                </select>
              </FieldRow>
            </div>
            <FieldRow label="Consent text (hashed)" htmlFor="consent-text" hint="Provide the versioned text shown to the patient; only its hash is stored.">
              <textarea id="consent-text" className="min-h-20 w-full rounded-lg border border-input bg-transparent p-2 text-sm dark:bg-input/30" value={form.consentText} onChange={(e) => setForm((f) => ({ ...f, consentText: e.target.value }))} data-testid="privacy-consent-text" />
            </FieldRow>
            <div className="grid grid-cols-2 gap-2">
              <FieldRow label="Source" htmlFor="consent-source">
                <Input id="consent-source" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} />
              </FieldRow>
              <FieldRow label="Valid to (optional)" htmlFor="consent-validto">
                <Input id="consent-validto" type="date" value={form.validTo} onChange={(e) => setForm((f) => ({ ...f, validTo: e.target.value }))} />
              </FieldRow>
            </div>
            <Button type="submit" size="sm" disabled={busy !== null} data-testid="privacy-consent-submit">{busy === "recordConsent" ? "Saving…" : "Record consent"}</Button>
          </form>
        </Panel>

        <Panel title="Withdraw consent" description="Withdrawal takes effect immediately for future use." testId="privacy-consent-withdraw">
          <form className="space-y-3" onSubmit={submitWithdraw}>
            <FieldRow label="Consent ID" htmlFor="withdraw-id">
              <Input id="withdraw-id" value={withdraw.consentId} onChange={(e) => setWithdraw((f) => ({ ...f, consentId: e.target.value }))} required placeholder="Consent record UUID" />
            </FieldRow>
            <FieldRow label="Reason (optional)" htmlFor="withdraw-reason">
              <Input id="withdraw-reason" value={withdraw.reason} onChange={(e) => setWithdraw((f) => ({ ...f, reason: e.target.value }))} />
            </FieldRow>
            <Button type="submit" size="sm" variant="outline" disabled={busy !== null}>{busy === "withdrawConsent" ? "Withdrawing…" : "Withdraw consent"}</Button>
          </form>
        </Panel>

        <Panel title="Export patient data" description="Generates a patient data export bundle (DPO/administrator). Downloaded as JSON." testId="privacy-export">
          <form className="space-y-3" onSubmit={submitExport}>
            <FieldRow label="Patient ID" htmlFor="export-patient">
              <Input id="export-patient" value={exportId} onChange={(e) => setExportId(e.target.value)} required placeholder="Patient UUID" />
            </FieldRow>
            <Button type="submit" size="sm" variant="outline" disabled={exporting || busy !== null}>{exporting ? "Exporting…" : "Export data"}</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

function RequestsTab({ data, busy, run }: { data: PrivacyPayload; busy: string | null; run: RunFn }) {
  const [form, setForm] = useState({
    requestType: "access" as DataSubjectRequestType,
    subjectName: "",
    subjectContact: "",
    patientId: "",
  });
  const [complete, setComplete] = useState({ requestId: "", status: "completed" as "completed" | "rejected", outcome: "" });

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel title="Data-subject requests" description="Received requests and their SLA status. Overdue requests are highlighted." testId="privacy-requests">
        <DataTable
          rows={data.requests}
          testId="privacy-requests-table"
          empty="No data-subject requests."
          columns={[
            { key: "no", label: "Request", render: (row) => <span className="font-mono text-xs">{row.requestNo}</span> },
            { key: "subject", label: "Subject", render: (row) => <div><div className="font-medium">{row.subjectName}</div><div className="text-[11px] text-muted-foreground">{row.patientMrn ?? row.patientId ?? row.subjectContact ?? "—"}</div></div> },
            { key: "type", label: "Type", render: (row) => row.requestType },
            { key: "status", label: "Status", render: (row) => row.isOverdue ? <StatusPill tone="bad">Overdue · {row.status}</StatusPill> : <StatusPill tone={row.status === "completed" ? "good" : "warn"}>{row.status}</StatusPill> },
            { key: "due", label: "Due", render: (row) => formatDate(row.dueAt) },
          ]}
        />
      </Panel>
      <div className="space-y-4">
        <Panel title="Log request" description="Record a data-subject request as received." testId="privacy-request-form">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run("createDataSubjectRequest", "createDataSubjectRequest", { requestType: form.requestType, subjectName: form.subjectName.trim(), subjectContact: form.subjectContact.trim() || undefined, patientId: form.patientId.trim() || undefined }, "Request logged."); }}>
            <FieldRow label="Request type" htmlFor="dsar-type">
              <select id="dsar-type" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.requestType} onChange={(e) => setForm((f) => ({ ...f, requestType: e.target.value as DataSubjectRequestType }))}>
                {DSAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Subject name" htmlFor="dsar-name"><Input id="dsar-name" value={form.subjectName} onChange={(e) => setForm((f) => ({ ...f, subjectName: e.target.value }))} required /></FieldRow>
            <FieldRow label="Contact (optional)" htmlFor="dsar-contact"><Input id="dsar-contact" value={form.subjectContact} onChange={(e) => setForm((f) => ({ ...f, subjectContact: e.target.value }))} /></FieldRow>
            <FieldRow label="Patient ID (optional)" htmlFor="dsar-patient"><Input id="dsar-patient" value={form.patientId} onChange={(e) => setForm((f) => ({ ...f, patientId: e.target.value }))} placeholder="Link to patient UUID if known" /></FieldRow>
            <Button type="submit" size="sm" disabled={busy !== null}>{busy === "createDataSubjectRequest" ? "Saving…" : "Log request"}</Button>
          </form>
        </Panel>
        <Panel title="Complete request" description="Record the outcome. Erasure is restricted when legal holds apply." testId="privacy-request-complete">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run("completeDataSubjectRequest", "completeDataSubjectRequest", { requestId: complete.requestId.trim(), status: complete.status, outcome: complete.outcome.trim() || undefined }, "Request updated."); }}>
            <FieldRow label="Request ID" htmlFor="dsar-id"><Input id="dsar-id" value={complete.requestId} onChange={(e) => setComplete((f) => ({ ...f, requestId: e.target.value }))} required placeholder="Request UUID" /></FieldRow>
            <FieldRow label="Outcome status" htmlFor="dsar-status">
              <select id="dsar-status" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={complete.status} onChange={(e) => setComplete((f) => ({ ...f, status: e.target.value as "completed" | "rejected" }))}>
                <option value="completed">Completed</option>
                <option value="rejected">Rejected</option>
              </select>
            </FieldRow>
            <FieldRow label="Outcome notes" htmlFor="dsar-outcome"><textarea id="dsar-outcome" className="min-h-16 w-full rounded-lg border border-input bg-transparent p-2 text-sm dark:bg-input/30" value={complete.outcome} onChange={(e) => setComplete((f) => ({ ...f, outcome: e.target.value }))} /></FieldRow>
            <Button type="submit" size="sm" variant="outline" disabled={busy !== null}>{busy === "completeDataSubjectRequest" ? "Saving…" : "Complete request"}</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

function BreachesTab({ data, busy, run }: { data: PrivacyPayload; busy: string | null; run: RunFn }) {
  const [form, setForm] = useState({
    severity: "medium" as BreachSeverity,
    description: "",
    affectedCount: "",
    dataCategories: "",
  });
  const [notify, setNotify] = useState({ breachId: "", target: "odpc" as "odpc" | "subject" });

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel title="Breaches" description="Recorded incidents with ODPC 72-hour and subject-notification clocks." testId="privacy-breaches">
        <div className="space-y-4" data-testid="privacy-breaches-list">
          {data.breaches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No breaches recorded.</p>
          ) : (
            data.breaches.map((breach) => (
              <article key={breach.id} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusPill tone={breach.severity === "critical" || breach.severity === "high" ? "bad" : breach.severity === "medium" ? "warn" : "neutral"}>{breach.severity}</StatusPill>
                    <span className="text-sm font-medium">{breach.status}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">Detected {formatDateTime(breach.detectedAt)}</span>
                </div>
                <p className="text-sm">{breach.description}</p>
                <p className="text-xs text-muted-foreground">
                  Affected: {breach.affectedCount ?? "—"} · Categories: {breach.dataCategories.length ? breach.dataCategories.join(", ") : "—"}
                </p>
                <BreachClock breach={breach} />
                <p className="font-mono text-[10px] text-muted-foreground">ID: {breach.id}</p>
              </article>
            ))
          )}
        </div>
      </Panel>
      <div className="space-y-4">
        <Panel title="Record breach" description="Log a personal-data breach. Notification clocks start from detection." testId="privacy-breach-form">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run("recordBreach", "recordBreach", { severity: form.severity, description: form.description.trim(), affectedCount: form.affectedCount ? Number(form.affectedCount) : undefined, dataCategories: form.dataCategories.split(",").map((s) => s.trim()).filter(Boolean) }, "Breach recorded."); }}>
            <FieldRow label="Severity" htmlFor="breach-severity">
              <select id="breach-severity" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as BreachSeverity }))}>
                {BREACH_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FieldRow>
            <FieldRow label="Description" htmlFor="breach-desc"><textarea id="breach-desc" className="min-h-20 w-full rounded-lg border border-input bg-transparent p-2 text-sm dark:bg-input/30" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} required /></FieldRow>
            <FieldRow label="Affected count (optional)" htmlFor="breach-count"><Input id="breach-count" type="number" min={0} value={form.affectedCount} onChange={(e) => setForm((f) => ({ ...f, affectedCount: e.target.value }))} /></FieldRow>
            <FieldRow label="Data categories (comma-separated)" htmlFor="breach-cats"><Input id="breach-cats" value={form.dataCategories} onChange={(e) => setForm((f) => ({ ...f, dataCategories: e.target.value }))} placeholder="clinical, contact, identifiers" /></FieldRow>
            <Button type="submit" size="sm" disabled={busy !== null}>{busy === "recordBreach" ? "Saving…" : "Record breach"}</Button>
          </form>
        </Panel>
        <Panel title="Mark notified" description="Record ODPC or data-subject notification time (now)." testId="privacy-breach-notify">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const now = new Date().toISOString(); void run("notifyBreach", "notifyBreach", { breachId: notify.breachId.trim(), odpcNotifiedAt: notify.target === "odpc" ? now : undefined, subjectNotifiedAt: notify.target === "subject" ? now : undefined }, "Notification recorded."); }}>
            <FieldRow label="Breach ID" htmlFor="notify-id"><Input id="notify-id" value={notify.breachId} onChange={(e) => setNotify((f) => ({ ...f, breachId: e.target.value }))} required placeholder="Breach UUID" /></FieldRow>
            <FieldRow label="Notify" htmlFor="notify-target">
              <select id="notify-target" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={notify.target} onChange={(e) => setNotify((f) => ({ ...f, target: e.target.value as "odpc" | "subject" }))}>
                <option value="odpc">ODPC (72-hour)</option>
                <option value="subject">Data subjects</option>
              </select>
            </FieldRow>
            <Button type="submit" size="sm" variant="outline" disabled={busy !== null}>{busy === "notifyBreach" ? "Saving…" : "Record notification"}</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

function RetentionTab({ data, busy, run }: { data: PrivacyPayload; busy: string | null; run: RunFn }) {
  const [form, setForm] = useState({ entity: "patient_restriction", triggerEvent: "", legalHold: "true", holdReason: "", retentionYears: "0" });

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel title="Retention & holds" description="Items due for review/destruction and active legal holds (including patient restrictions)." testId="privacy-retention">
        <DataTable
          rows={data.retentionDue}
          testId="privacy-retention-table"
          empty="No retention items due."
          columns={[
            { key: "entity", label: "Entity", render: (row) => row.entity },
            { key: "trigger", label: "Trigger / subject", render: (row) => <span className="font-mono text-xs">{row.triggerEvent}</span> },
            { key: "destroy", label: "Destroy after", render: (row) => formatDate(row.destroyAfter) },
            { key: "hold", label: "Legal hold", render: (row) => row.legalHold ? <StatusPill tone="warn">On hold</StatusPill> : <StatusPill tone="neutral">No</StatusPill> },
            { key: "review", label: "Review at", render: (row) => formatDateTime(row.reviewAt) },
          ]}
        />
      </Panel>
      <Panel title="Restrict patient record" description="Applies or lifts a chart restriction/legal hold for a patient (requires reason when restricting)." testId="privacy-restrict-form">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run("restrictPatientRecord", "restrictPatientRecord", { patientId: form.triggerEvent.trim(), legalHold: form.legalHold === "true", holdReason: form.holdReason.trim() || undefined, retentionYears: Number(form.retentionYears || 0), entity: "patient_restriction", triggerEvent: form.triggerEvent.trim() }, form.legalHold === "true" ? "Patient record restricted." : "Patient restriction lifted."); }}>
          <FieldRow label="Patient ID" htmlFor="restrict-patient"><Input id="restrict-patient" value={form.triggerEvent} onChange={(e) => setForm((f) => ({ ...f, triggerEvent: e.target.value }))} required placeholder="Patient UUID" /></FieldRow>
          <FieldRow label="Legal hold / restricted" htmlFor="restrict-hold">
            <select id="restrict-hold" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.legalHold} onChange={(e) => setForm((f) => ({ ...f, legalHold: e.target.value }))}>
              <option value="true">Restricted (hold on)</option>
              <option value="false">Not restricted (lift hold)</option>
            </select>
          </FieldRow>
          <FieldRow label="Reason (required when restricting)" htmlFor="restrict-reason"><Input id="restrict-reason" value={form.holdReason} onChange={(e) => setForm((f) => ({ ...f, holdReason: e.target.value }))} placeholder="Reason for restriction" /></FieldRow>
          <Button type="submit" size="sm" disabled={busy !== null}>{busy === "restrictPatientRecord" ? "Saving…" : "Save restriction"}</Button>
        </form>
      </Panel>
    </div>
  );
}

function SharingTab({ data, busy, run }: { data: PrivacyPayload; busy: string | null; run: RunFn }) {
  const [form, setForm] = useState({ counterpartyName: "", counterpartyType: "payer", purpose: "billing", status: "active", effectiveFrom: "", effectiveTo: "" });

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel title="Sharing agreements" description="Processor/controller/payer agreements required for payer sharing and third-party transfers." testId="privacy-sharing">
        <DataTable
          rows={data.sharingAgreements}
          testId="privacy-sharing-table"
          empty="No sharing agreements."
          columns={[
            { key: "name", label: "Counterparty", render: (row) => <div><div className="font-medium">{row.counterpartyName}</div><div className="text-[11px] text-muted-foreground">{row.counterpartyType} · {row.purpose}</div></div> },
            { key: "status", label: "Status", render: (row) => <StatusPill tone={row.status === "active" ? "good" : row.status === "expired" ? "bad" : "neutral"}>{row.status}</StatusPill> },
            { key: "effective", label: "Effective", render: (row) => `${formatDate(row.effectiveFrom)} – ${formatDate(row.effectiveTo)}` },
            { key: "id", label: "ID", render: (row) => <span className="font-mono text-[11px]">{row.id.slice(0, 8)}…</span> },
          ]}
        />
      </Panel>
      <Panel title="Create agreement" description="Record a data sharing/processing agreement." testId="privacy-sharing-form">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run("createSharingAgreement", "createSharingAgreement", { counterpartyName: form.counterpartyName.trim(), counterpartyType: form.counterpartyType, purpose: form.purpose, status: form.status, effectiveFrom: form.effectiveFrom ? new Date(form.effectiveFrom).toISOString() : undefined, effectiveTo: form.effectiveTo ? new Date(form.effectiveTo).toISOString() : undefined }, "Sharing agreement saved."); }}>
          <FieldRow label="Counterparty name" htmlFor="share-name"><Input id="share-name" value={form.counterpartyName} onChange={(e) => setForm((f) => ({ ...f, counterpartyName: e.target.value }))} required /></FieldRow>
          <FieldRow label="Counterparty type" htmlFor="share-type">
            <select id="share-type" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.counterpartyType} onChange={(e) => setForm((f) => ({ ...f, counterpartyType: e.target.value }))}>
              {SHARING_COUNTERPARTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Purpose" htmlFor="share-purpose">
            <Input id="share-purpose" value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} required placeholder="e.g. billing, claims processing" />
          </FieldRow>
          <FieldRow label="Status" htmlFor="share-status">
            <select id="share-status" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="expired">expired</option>
              <option value="terminated">terminated</option>
            </select>
          </FieldRow>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Effective from" htmlFor="share-from"><Input id="share-from" type="date" value={form.effectiveFrom} onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))} /></FieldRow>
            <FieldRow label="Effective to" htmlFor="share-to"><Input id="share-to" type="date" value={form.effectiveTo} onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))} /></FieldRow>
          </div>
          <Button type="submit" size="sm" disabled={busy !== null}>{busy === "createSharingAgreement" ? "Saving…" : "Create agreement"}</Button>
        </form>
      </Panel>
    </div>
  );
}

function TransfersTab({ data, busy, run }: { data: PrivacyPayload; busy: string | null; run: RunFn }) {
  const [form, setForm] = useState({ destinationCountry: "", legalBasis: "", safeguards: "", dataCategories: "", riskLevel: "medium", approved: "false" });

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel title="Cross-border transfers" description="Transfer impact assessments and approvals." testId="privacy-transfers">
        <DataTable
          rows={data.transfers}
          testId="privacy-transfers-table"
          empty="No transfer assessments."
          columns={[
            { key: "dest", label: "Destination", render: (row) => row.destinationCountry },
            { key: "basis", label: "Legal basis", render: (row) => row.legalBasis },
            { key: "risk", label: "Risk", render: (row) => row.riskLevel ?? "—" },
            { key: "approved", label: "Approved", render: (row) => row.approved ? <StatusPill tone="good">Approved</StatusPill> : <StatusPill tone="warn">Pending</StatusPill> },
            { key: "review", label: "Review at", render: (row) => formatDate(row.reviewAt) },
          ]}
        />
      </Panel>
      <Panel title="Record assessment" description="Record a cross-border transfer assessment." testId="privacy-transfer-form">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run("recordTransferAssessment", "recordTransferAssessment", { destinationCountry: form.destinationCountry.trim(), legalBasis: form.legalBasis.trim(), safeguards: form.safeguards.trim() || undefined, dataCategories: form.dataCategories.split(",").map((s) => s.trim()).filter(Boolean), riskLevel: form.riskLevel, approved: form.approved === "true" }, "Transfer assessment saved."); }}>
          <FieldRow label="Destination country" htmlFor="tx-country"><Input id="tx-country" value={form.destinationCountry} onChange={(e) => setForm((f) => ({ ...f, destinationCountry: e.target.value }))} required /></FieldRow>
          <FieldRow label="Legal basis" htmlFor="tx-basis"><Input id="tx-basis" value={form.legalBasis} onChange={(e) => setForm((f) => ({ ...f, legalBasis: e.target.value }))} required /></FieldRow>
          <FieldRow label="Safeguards" htmlFor="tx-safeguards"><Input id="tx-safeguards" value={form.safeguards} onChange={(e) => setForm((f) => ({ ...f, safeguards: e.target.value }))} /></FieldRow>
          <FieldRow label="Data categories (comma-separated)" htmlFor="tx-cats"><Input id="tx-cats" value={form.dataCategories} onChange={(e) => setForm((f) => ({ ...f, dataCategories: e.target.value }))} /></FieldRow>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Risk level" htmlFor="tx-risk">
              <select id="tx-risk" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.riskLevel} onChange={(e) => setForm((f) => ({ ...f, riskLevel: e.target.value }))}>
                <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
              </select>
            </FieldRow>
            <FieldRow label="Approved" htmlFor="tx-approved">
              <select id="tx-approved" className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={form.approved} onChange={(e) => setForm((f) => ({ ...f, approved: e.target.value }))}>
                <option value="false">Pending</option><option value="true">Approved</option>
              </select>
            </FieldRow>
          </div>
          <Button type="submit" size="sm" disabled={busy !== null}>{busy === "recordTransferAssessment" ? "Saving…" : "Save assessment"}</Button>
        </form>
      </Panel>
    </div>
  );
}

function AccessLogTab({ data }: { data: PrivacyPayload }) {
  return (
    <Panel title="Chart access log" description="Audited access to patient charts, including restricted-chart access with reason." testId="privacy-access-log">
      <DataTable
        rows={data.accessLog}
        testId="privacy-access-table"
        empty="No chart access records."
        columns={[
          { key: "when", label: "When", render: (row) => <span className="font-mono text-xs">{formatDateTime(row.accessedAt)}</span> },
          { key: "patient", label: "Patient ID", render: (row) => <span className="font-mono text-[11px]">{row.patientId}</span> },
          { key: "encounter", label: "Encounter", render: (row) => <span className="font-mono text-[11px]">{row.encounterId ?? "—"}</span> },
          { key: "user", label: "User", render: (row) => row.userName ?? row.userId },
          { key: "reason", label: "Reason", render: (row) => row.reason },
          { key: "break", label: "Break-glass", render: (row) => row.isBreakGlass ? <StatusPill tone="warn">Yes</StatusPill> : "No" },
        ]}
      />
    </Panel>
  );
}
