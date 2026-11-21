"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { ReadinessStatus } from "@/lib/regulatory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingPanel } from "@/components/ui/loading-panel";
import { cn } from "cn";

import {
  DataTable,
  Panel,
  RecordForm,
  requestJson,
  type Field,
  type FieldValue,
} from "./admin-workspace";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ReadinessDomain {
  domain: string;
  status: ReadinessStatus;
  daysToExpiry: number | null;
  detail: string;
}

interface SettingRow {
  id: string;
  domain: string;
  key: string;
  dataType: "text" | "integer" | "decimal" | "boolean" | "date" | "enum" | "json";
  allowedValues: string[] | null;
  isRequired: boolean;
  isSecret: boolean;
  effectiveFrom: string;
  updatedBy: string | null;
  displayValue: string;
  label: string;
  description: string;
  missing: boolean;
}

interface ProfileRow {
  facilityId: string;
  kmpdcNumber: string | null;
  kmhflId: string | null;
  kephLevel: number | null;
  facilityCategory: string | null;
  ownership: string | null;
  county: string | null;
  subCounty: string | null;
  licenceNo: string | null;
  licenceIssueDate: string | null;
  licenceExpiryDate: string | null;
  licenceStatus: string;
  odpcRegistrationNo: string | null;
  odpcExpiryDate: string | null;
  shaFacilityCode: string | null;
  shaEmpanelmentStatus: string | null;
  kraPin: string | null;
  updatedAt: string;
}

interface LicenceRow {
  id: string;
  licenceType: string;
  licenceNo: string;
  issueDate: string | null;
  expiryDate: string;
  status: string;
  supersedesId: string | null;
}

interface PractitionerRow {
  id: string;
  staffProfileId: string;
  regulator: string;
  profession: string;
  registrationNo: string;
  licenceExpiryDate: string | null;
  licenceStatus: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  active: boolean;
}

interface ServiceRow {
  id: string;
  serviceType: string;
  licenceNo: string;
  issuingAuthority: string;
  expiryDate: string;
  status: string;
  active: boolean;
}

interface IdentifierRow {
  id: string;
  identifierType: string;
  value: string;
  issuingAuthority: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: string | null;
}

interface AlertRuleRow {
  id: string;
  subjectType: string;
  warnDays: number[];
  blockDays: number[];
  notifyRoles: string[];
  enabled: boolean;
}

interface StaffRow {
  staffProfileId: string;
  name: string;
  staffNumber: string;
  role: string;
}

interface IntegrationRow {
  id: string;
  integration: string;
  environment: string;
  baseUrl: string | null;
  mode: string | null;
  credentialRef: string | null;
  enabled: boolean;
  lastVerifiedAt: string | null;
}

interface RateRow {
  id: string;
  rateType: string;
  bandOrder: number;
  lowerBound: string;
  upperBound: string | null;
  ratePercent: string;
  effectiveFrom: string;
}

interface FeeRow {
  id: string;
  authority: string;
  category: string;
  amount: string;
  currency: string;
  effectiveFrom: string;
}

interface ShaCodeRow {
  id: string;
  code: string;
  description: string;
  category: string;
  retryable: boolean;
  active: boolean;
}

interface RegulatoryPayload {
  facilityId: string;
  facility: {
    code: string;
    name: string;
    isPlaceholder: boolean;
  };
  profile: ProfileRow | null;
  licences: LicenceRow[];
  practitioners: PractitionerRow[];
  supportServices: ServiceRow[];
  identifiers: IdentifierRow[];
  alertRules: AlertRuleRow[];
  readiness: {
    asOf: string;
    warnDays: number;
    overall: "compliant" | "attention" | "blocked";
    domains: ReadinessDomain[];
  };
  expiring: Array<{
    id: string;
    subjectType: string;
    reference: string;
    label: string;
    expiryDate: string;
    daysToExpiry: number;
    status: string;
  }>;
  settings: SettingRow[];
  rates: RateRow[];
  fees: FeeRow[];
  shaCodes: ShaCodeRow[];
  integrations: IntegrationRow[];
  staff: StaffRow[];
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

const STATUS_STYLE: Record<ReadinessStatus, { label: string; className: string }> = {
  compliant: {
    label: "Compliant",
    className:
      "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)] border-[var(--status-normal)]/30",
  },
  expiring: {
    label: "Expiring",
    className:
      "bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)] border-[var(--status-warning)]/30",
  },
  expired: {
    label: "Expired",
    className:
      "bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)] border-[var(--status-critical)]/30",
  },
  missing: {
    label: "Missing",
    className: "bg-muted text-muted-foreground border-border",
  },
};

const DOMAIN_LABELS: Record<string, string> = {
  kmpdc: "KMPDC facility licence",
  sha: "SHA empanelment",
  odpc: "ODPC registration",
  tax: "KRA tax identity",
  pharmacy: "Pharmacy (PPB)",
  laboratory: "Laboratory (KMLTTB)",
  imaging: "Imaging (RPB)",
  quality: "Quality certification",
};

const SETTING_DOMAIN_ORDER = [
  "regulatory",
  "tax",
  "reporting",
  "sha",
  "payroll",
  "privacy",
  "quality",
] as const;

const SETTING_DOMAIN_LABELS: Record<string, string> = {
  regulatory: "Regulatory",
  tax: "Tax",
  reporting: "Reporting",
  sha: "SHA",
  payroll: "Payroll",
  privacy: "Privacy",
  quality: "Quality",
  integrations: "Integrations",
  statutory: "Statutory tables",
};

function StatusPill({ status }: { status: ReadinessStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

function daysLabel(days: number | null) {
  if (days === null) return "No expiry recorded";
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  if (days === 0) return "Expires today";
  return `${days} day${days === 1 ? "" : "s"} left`;
}

function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.slice(0, 10);
}

const TABS = [
  { id: "profile", label: "Facility profile" },
  { id: "practitioners", label: "Practitioners" },
  { id: "services", label: "Support services" },
  { id: "identifiers", label: "Identifiers" },
  { id: "alerts", label: "Alerts" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function EntryGuidance({
  data,
  busy,
  run,
  onOpenEntry,
}: {
  data: RegulatoryPayload;
  busy: string | null;
  run: (
    label: string,
    command: string,
    input: Record<string, unknown>,
    success: string,
  ) => Promise<boolean>;
  onOpenEntry: () => void;
}) {
  const placeholder = data.facility.isPlaceholder;
  return (
    <section
      className={cn(
        "rounded-lg border px-4 py-3",
        placeholder
          ? "border-[var(--status-critical)]/40 bg-[var(--status-critical-background)]"
          : "border-border bg-card",
      )}
      data-testid="regulatory-entry-guidance"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p
            className={cn(
              "font-mono text-[10px] uppercase tracking-[0.18em]",
              placeholder
                ? "text-[var(--status-critical-foreground)]"
                : "text-muted-foreground",
            )}
          >
            {placeholder ? "TEST PLACEHOLDER DATA" : "Regulatory data entry"}
          </p>
          <h2 className="text-sm font-semibold text-primary">
            {placeholder ? "Local sandbox: invented values only" : "Enter values in the tabs below"}
          </h2>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            {placeholder
              ? `Facility ${data.facility.code} is a local test sandbox. Every value below is invented and must never be used for billing, claims or compliance evidence.`
              : "Use the tabs below to record regulator values. Document upload is not available yet; use Document reference to point to the signed source."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onOpenEntry}>
            Open data entry
          </Button>
          {placeholder ? (
            <Button
              type="button"
              size="sm"
              disabled={Boolean(busy)}
              data-testid="regulatory-placeholder-load"
              onClick={() =>
                void run(
                  "placeholders",
                  "loadRegulatoryTestPlaceholders",
                  {},
                  "TEST placeholders loaded.",
                )
              }
            >
              {busy === "placeholders" ? "Loading..." : "Load TEST placeholders"}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function RegulatoryPanel() {
  const [data, setData] = useState<RegulatoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("profile");
  const [settingDomain, setSettingDomain] = useState<string>("regulatory");

  const load = useCallback(async () => {
    try {
      setData(await requestJson<RegulatoryPayload>("/api/admin/regulatory"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load regulatory data");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (
      label: string,
      command: string,
      input: Record<string, unknown>,
      success: string,
    ) => {
      setBusy(label);
      try {
        await requestJson<{ result: unknown }>("/api/admin/regulatory", {
          method: "POST",
          headers: { "content-type": "application/json", "x-device-id": "admin-station" },
          body: JSON.stringify({
            command,
            input: { ...input, idempotencyKey: crypto.randomUUID() },
          }),
        });
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

  const openEntry = useCallback(() => {
    setTab("profile");
    requestAnimationFrame(() => {
      document.getElementById("regulatory-entry-tabs")?.scrollIntoView({ block: "start" });
    });
  }, []);

  if (error) {
    return (
      <Panel title="Regulatory" description={error} testId="regulatory-error">
        <Button size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </Panel>
    );
  }

  if (!data) return <LoadingPanel label="Loading regulatory readiness" />;

  return (
    <div className="space-y-4" data-testid="regulatory-panel">
      <ReadinessSummary data={data} />
      <EntryGuidance data={data} busy={busy} run={run} onOpenEntry={openEntry} />

      <div
        id="regulatory-entry-tabs"
        className="flex flex-wrap gap-1 border-b border-border"
        role="tablist"
        aria-label="Regulatory sections"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`regulatory-tab-${item.id}`}
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

      {tab === "profile" ? <ProfileTab data={data} busy={busy} run={run} /> : null}
      {tab === "practitioners" ? <PractitionersTab data={data} busy={busy} run={run} /> : null}
      {tab === "services" ? <ServicesTab data={data} busy={busy} run={run} /> : null}
      {tab === "identifiers" ? <IdentifiersTab data={data} busy={busy} run={run} /> : null}
      {tab === "alerts" ? <AlertsTab data={data} busy={busy} run={run} /> : null}
      {tab === "settings" ? (
        <SettingsTab
          data={data}
          busy={busy}
          run={run}
          domain={settingDomain}
          setDomain={setSettingDomain}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

function ReadinessSummary({ data }: { data: RegulatoryPayload }) {
  const { readiness, expiring } = data;
  return (
    <section className="space-y-3" data-testid="regulatory-readiness">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-primary">Readiness as of {readiness.asOf}</h2>
          <p className="text-xs text-muted-foreground">
            Licences inside {readiness.warnDays} days of expiry are flagged before they lapse.
          </p>
        </div>
        <StatusPill
          status={
            readiness.overall === "compliant"
              ? "compliant"
              : readiness.overall === "blocked"
                ? "expired"
                : "expiring"
          }
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {readiness.domains.map((domain) => (
          <div
            key={domain.domain}
            className="rounded-lg border border-border bg-card p-3"
            data-testid={`readiness-${domain.domain}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {domain.domain}
              </span>
              <StatusPill status={domain.status} />
            </div>
            <p className="mt-2 text-sm font-medium text-foreground">
              {DOMAIN_LABELS[domain.domain] ?? domain.domain}
            </p>
            <p className="text-xs text-muted-foreground">{daysLabel(domain.daysToExpiry)}</p>
          </div>
        ))}
      </div>

      <Panel
        title="Expiring in the next 30 days"
        description="Facility, practitioner and support-service licences that need renewal."
        testId="regulatory-expiring"
      >
        <DataTable
          rows={expiring}
          testId="regulatory-expiring-table"
          empty="Nothing expires in the next 30 days."
          columns={[
            { key: "subject", label: "Subject", render: (row) => row.subjectType },
            { key: "label", label: "Licence", render: (row) => row.label },
            { key: "reference", label: "Reference", render: (row) => row.reference },
            { key: "expiry", label: "Expires", render: (row) => row.expiryDate },
            { key: "days", label: "Window", render: (row) => daysLabel(row.daysToExpiry) },
          ]}
        />
      </Panel>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

type RunFn = (
  label: string,
  command: string,
  input: Record<string, unknown>,
  success: string,
) => Promise<boolean>;

const PROFILE_FIELDS: Field[] = [
  { name: "kmpdcNumber", label: "KMPDC number" },
  { name: "kmhflId", label: "KMHFL ID" },
  {
    name: "kephLevel",
    label: "KEPH level",
    type: "select",
    options: [1, 2, 3, 4, 5, 6].map((level) => ({
      value: String(level),
      label: `Level ${level}`,
    })),
  },
  {
    name: "facilityCategory",
    label: "KMPDC category",
    type: "select",
    options: [
      "dispensary",
      "medical_clinic",
      "health_centre",
      "medical_centre",
      "hospital_level_4",
      "hospital_level_5",
      "maternity_home",
      "nursing_home",
      "dental_clinic",
      "eye_clinic",
    ].map((value) => ({ value, label: value.replaceAll("_", " ") })),
  },
  {
    name: "ownership",
    label: "Ownership",
    type: "select",
    options: ["public", "faith_based", "private", "ngo"].map((value) => ({
      value,
      label: value.replaceAll("_", " "),
    })),
  },
  { name: "county", label: "County", required: true },
  { name: "subCounty", label: "Sub-county", required: true },
  { name: "licenceNo", label: "KMPDC licence number" },
  { name: "licenceIssueDate", label: "Licence issue date", type: "text", placeholder: "YYYY-MM-DD" },
  { name: "licenceExpiryDate", label: "Licence expiry date", placeholder: "YYYY-MM-DD" },
  { name: "kraPin", label: "KRA PIN", placeholder: "P052292910Q" },
  { name: "odpcRegistrationNo", label: "ODPC registration number" },
  { name: "odpcExpiryDate", label: "ODPC expiry date", placeholder: "YYYY-MM-DD" },
  { name: "shaFacilityCode", label: "SHA facility code" },
  { name: "shaEmpanelmentStatus", label: "SHA empanelment status", placeholder: "active" },
];

function ProfileTab({ data, busy, run }: { data: RegulatoryPayload; busy: string | null; run: RunFn }) {
  const profile = data.profile;
  const initial = useMemo<Record<string, FieldValue>>(
    () => ({
      kmpdcNumber: profile?.kmpdcNumber ?? "",
      kmhflId: profile?.kmhflId ?? "",
      kephLevel: profile?.kephLevel ? String(profile.kephLevel) : "",
      facilityCategory: profile?.facilityCategory ?? "",
      ownership: profile?.ownership ?? "",
      county: profile?.county ?? "",
      subCounty: profile?.subCounty ?? "",
      licenceNo: profile?.licenceNo ?? "",
      licenceIssueDate: profile?.licenceIssueDate ?? "",
      licenceExpiryDate: profile?.licenceExpiryDate ?? "",
      kraPin: profile?.kraPin ?? "",
      odpcRegistrationNo: profile?.odpcRegistrationNo ?? "",
      odpcExpiryDate: profile?.odpcExpiryDate ?? "",
      shaFacilityCode: profile?.shaFacilityCode ?? "",
      shaEmpanelmentStatus: profile?.shaEmpanelmentStatus ?? "",
    }),
    [profile],
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel
        title="Legal identity"
        description="Every field here feeds billing, claiming and statutory reporting. Unconfirmed values stay empty and report as missing."
        testId="regulatory-profile"
      >
        <RecordForm
          key={profile?.updatedAt ?? "new"}
          testId="regulatory-profile-form"
          submitLabel="Save profile"
          busy={busy}
          fields={PROFILE_FIELDS}
          initial={initial}
          onSubmit={async (values) => {
            const ok = await run(
              "profile",
              "upsertFacilityRegulatoryProfile",
              {
                ...values,
                kephLevel: values.kephLevel ? Number(values.kephLevel) : undefined,
                facilityCategory: values.facilityCategory || undefined,
                ownership: values.ownership || undefined,
                licenceIssueDate: toIsoDate(values.licenceIssueDate),
                licenceExpiryDate: toIsoDate(values.licenceExpiryDate),
                odpcExpiryDate: toIsoDate(values.odpcExpiryDate),
              },
              "Facility profile saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>

      <div className="space-y-4">
        <Panel
          title="Licence renewals"
          description="Renewals append a row and keep the previous licence intact."
          testId="regulatory-licence-form"
        >
          <RecordForm
            testId="regulatory-licence-renew"
            submitLabel="Record licence"
            busy={busy}
            fields={[
              { name: "licenceNo", label: "Licence number", required: true },
              { name: "issueDate", label: "Issue date", placeholder: "YYYY-MM-DD" },
              { name: "expiryDate", label: "Expiry date", placeholder: "YYYY-MM-DD", required: true },
              { name: "documentRef", label: "Document reference" },
            ]}
            onSubmit={async (values) => {
              const ok = await run(
                "licence",
                "updateFacilityLicence",
                {
                  licenceType: "kmpdc_facility",
                  licenceNo: values.licenceNo,
                  issueDate: toIsoDate(values.issueDate),
                  expiryDate: toIsoDate(values.expiryDate),
                  documentRef: values.documentRef || undefined,
                },
                "Licence recorded.",
              );
              if (!ok) return;
            }}
          />
        </Panel>

        <Panel
          title="Licence history"
          description="Append-only. The newest row is the licence in force."
          testId="regulatory-licence-history"
        >
          <DataTable
            rows={data.licences}
            testId="regulatory-licence-table"
            empty="No licence recorded yet."
            columns={[
              { key: "type", label: "Type", render: (row) => row.licenceType },
              { key: "no", label: "Number", render: (row) => row.licenceNo },
              { key: "expiry", label: "Expires", render: (row) => row.expiryDate },
              {
                key: "status",
                label: "Status",
                render: (row) => <StatusPill status={statusToReadiness(row.status)} />,
              },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}

function statusToReadiness(status: string): ReadinessStatus {
  if (status === "active") return "compliant";
  if (status === "expiring") return "expiring";
  if (status === "expired" || status === "suspended") return "expired";
  return "missing";
}

/* ------------------------------------------------------------------ */
/* Practitioners                                                       */
/* ------------------------------------------------------------------ */

function PractitionersTab({
  data,
  busy,
  run,
}: {
  data: RegulatoryPayload;
  busy: string | null;
  run: RunFn;
}) {
  const [expiringOnly, setExpiringOnly] = useState(false);
  const names = new Map(data.staff.map((row) => [row.staffProfileId, row.name]));

  const rows = expiringOnly
    ? data.practitioners.filter(
        (row) =>
          row.licenceExpiryDate !== null &&
          data.expiring.some((expiry) => expiry.id === row.id),
      )
    : data.practitioners;

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel
        title="Practitioner registrations"
        description="One registration per practitioner and regulator. Verification needs an administrator or regulatory officer."
        testId="regulatory-practitioners"
      >
        <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={expiringOnly}
            onChange={(event) => setExpiringOnly(event.target.checked)}
          />
          Only licences expiring in 30 days
        </label>
        <DataTable
          rows={rows}
          testId="regulatory-practitioner-table"
          empty="No practitioner registrations yet."
          columns={[
            {
              key: "name",
              label: "Practitioner",
              render: (row) => names.get(row.staffProfileId) ?? row.staffProfileId.slice(0, 8),
            },
            { key: "regulator", label: "Regulator", render: (row) => row.regulator.toUpperCase() },
            { key: "no", label: "Registration", render: (row) => row.registrationNo },
            {
              key: "expiry",
              label: "Expires",
              render: (row) => row.licenceExpiryDate ?? "—",
            },
            {
              key: "status",
              label: "Status",
              render: (row) => <StatusPill status={statusToReadiness(row.licenceStatus)} />,
            },
            {
              key: "verified",
              label: "Verified",
              render: (row) =>
                row.verifiedAt ? row.verifiedAt.slice(0, 10) : <span className="text-muted-foreground">Not yet</span>,
            },
            {
              key: "action",
              label: "",
              render: (row) => (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      `verify-${row.id}`,
                      "verifyPractitionerLicence",
                      { registrationId: row.id },
                      "Practitioner licence verified.",
                    )
                  }
                >
                  Verify
                </Button>
              ),
            },
          ]}
        />
      </Panel>

      <Panel
        title="Add a registration"
        description="Registration numbers come from the practitioner's regulator."
        testId="regulatory-practitioner-form"
      >
        <RecordForm
          testId="regulatory-practitioner-new"
          submitLabel="Save registration"
          busy={busy}
          fields={[
            {
              name: "staffProfileId",
              label: "Staff member",
              type: "select",
              required: true,
              options: data.staff.map((row) => ({
                value: row.staffProfileId,
                label: `${row.name} · ${row.role}`,
              })),
            },
            {
              name: "regulator",
              label: "Regulator",
              type: "select",
              required: true,
              options: ["kmpdc", "ppb", "kmlttb", "nck", "rpb", "other"].map((value) => ({
                value,
                label: value.toUpperCase(),
              })),
            },
            { name: "profession", label: "Profession", required: true, placeholder: "medical" },
            { name: "registrationNo", label: "Registration number", required: true },
            { name: "licenceExpiryDate", label: "Licence expiry", placeholder: "YYYY-MM-DD" },
            { name: "cpdPoints", label: "CPD points" },
          ]}
          onSubmit={async (values) => {
            const ok = await run(
              "practitioner",
              "upsertPractitionerRegistration",
              {
                staffProfileId: values.staffProfileId,
                regulator: values.regulator,
                profession: values.profession,
                registrationNo: values.registrationNo,
                licenceExpiryDate: toIsoDate(values.licenceExpiryDate),
                cpdPoints: values.cpdPoints || undefined,
              },
              "Practitioner registration saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Support services                                                    */
/* ------------------------------------------------------------------ */

function ServicesTab({ data, busy, run }: { data: RegulatoryPayload; busy: string | null; run: RunFn }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel
        title="Support-service licences"
        description="Pharmacy, laboratory, imaging and other licensed services."
        testId="regulatory-services"
      >
        <DataTable
          rows={data.supportServices}
          testId="regulatory-service-table"
          empty="No support-service licence recorded yet."
          columns={[
            { key: "type", label: "Service", render: (row) => row.serviceType },
            { key: "no", label: "Licence", render: (row) => row.licenceNo },
            { key: "authority", label: "Issued by", render: (row) => row.issuingAuthority },
            { key: "expiry", label: "Expires", render: (row) => row.expiryDate },
            {
              key: "status",
              label: "Status",
              render: (row) => <StatusPill status={statusToReadiness(row.status)} />,
            },
          ]}
        />
      </Panel>

      <Panel title="Add a service licence" description="Expiry is required." testId="regulatory-service-form">
        <RecordForm
          testId="regulatory-service-new"
          submitLabel="Save licence"
          busy={busy}
          fields={[
            {
              name: "serviceType",
              label: "Service",
              type: "select",
              required: true,
              options: ["pharmacy", "laboratory", "imaging", "ambulance", "mortuary", "theatre"].map(
                (value) => ({ value, label: value }),
              ),
            },
            { name: "licenceNo", label: "Licence number", required: true },
            { name: "issuingAuthority", label: "Issuing authority", required: true },
            { name: "issueDate", label: "Issue date", placeholder: "YYYY-MM-DD" },
            { name: "expiryDate", label: "Expiry date", required: true, placeholder: "YYYY-MM-DD" },
          ]}
          onSubmit={async (values) => {
            const ok = await run(
              "service",
              "upsertSupportServiceLicence",
              {
                serviceType: values.serviceType,
                licenceNo: values.licenceNo,
                issuingAuthority: values.issuingAuthority,
                issueDate: toIsoDate(values.issueDate),
                expiryDate: toIsoDate(values.expiryDate),
              },
              "Support-service licence saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

function IdentifiersTab({ data, busy, run }: { data: RegulatoryPayload; busy: string | null; run: RunFn }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel
        title="Facility identifiers"
        description="Generic register for any regulator or bank identifier the facility holds."
        testId="regulatory-identifiers"
      >
        <DataTable
          rows={data.identifiers}
          testId="regulatory-identifier-table"
          empty="No identifiers recorded yet."
          columns={[
            { key: "type", label: "Type", render: (row) => row.identifierType },
            { key: "value", label: "Value", render: (row) => row.value },
            { key: "authority", label: "Issued by", render: (row) => row.issuingAuthority ?? "—" },
            { key: "valid", label: "Valid to", render: (row) => row.validTo ?? "—" },
            { key: "status", label: "Status", render: (row) => row.status ?? "—" },
          ]}
        />
      </Panel>

      <Panel title="Add an identifier" description="For example a bank account or PPB number." testId="regulatory-identifier-form">
        <RecordForm
          testId="regulatory-identifier-new"
          submitLabel="Save identifier"
          busy={busy}
          fields={[
            {
              name: "identifierType",
              label: "Type",
              type: "select",
              required: true,
              options: [
                "kra_pin",
                "nssf",
                "shif",
                "kmpdc",
                "kmhfl",
                "odpc",
                "ppb",
                "kmlttb",
                "rpb",
                "bank",
                "other",
              ].map((value) => ({ value, label: value.replaceAll("_", " ") })),
            },
            { name: "value", label: "Value", required: true },
            { name: "issuingAuthority", label: "Issued by" },
            { name: "validTo", label: "Valid to", placeholder: "YYYY-MM-DD" },
          ]}
          onSubmit={async (values) => {
            const ok = await run(
              "identifier",
              "upsertFacilityIdentifier",
              {
                identifierType: values.identifierType,
                value: values.value,
                issuingAuthority: values.issuingAuthority || undefined,
                validTo: toIsoDate(values.validTo),
              },
              "Identifier saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

function AlertsTab({ data, busy, run }: { data: RegulatoryPayload; busy: string | null; run: RunFn }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel
        title="Licence alert rules"
        description="Who hears about a licence, and how early."
        testId="regulatory-alerts"
      >
        <DataTable
          rows={data.alertRules}
          testId="regulatory-alert-table"
          empty="No alert rule recorded yet."
          columns={[
            { key: "subject", label: "Subject", render: (row) => row.subjectType },
            { key: "warn", label: "Warn (days)", render: (row) => row.warnDays.join(", ") },
            { key: "block", label: "Block (days)", render: (row) => row.blockDays.join(", ") },
            { key: "roles", label: "Notify", render: (row) => row.notifyRoles.join(", ") },
            { key: "enabled", label: "Enabled", render: (row) => (row.enabled ? "Yes" : "No") },
          ]}
        />
      </Panel>

      <Panel title="Add an alert rule" description="At least one role must be notified." testId="regulatory-alert-form">
        <RecordForm
          testId="regulatory-alert-new"
          submitLabel="Save rule"
          busy={busy}
          fields={[
            {
              name: "subjectType",
              label: "Subject",
              type: "select",
              required: true,
              options: ["facility", "practitioner", "support_service", "odpc", "sha"].map((value) => ({
                value,
                label: value.replaceAll("_", " "),
              })),
            },
            { name: "warnDays", label: "Warn days", placeholder: "60,30", required: true },
            { name: "blockDays", label: "Block days", placeholder: "0", required: true },
            {
              name: "notifyRoles",
              label: "Notify roles",
              placeholder: "regulatory_officer,admin",
              required: true,
            },
          ]}
          onSubmit={async (values) => {
            const parse = (value: FieldValue) =>
              String(value ?? "")
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean);
            const ok = await run(
              "alert",
              "createLicenceAlertRule",
              {
                subjectType: values.subjectType,
                warnDays: parse(values.warnDays).map(Number),
                blockDays: parse(values.blockDays).map(Number),
                notifyRoles: parse(values.notifyRoles),
              },
              "Alert rule saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function SettingsTab({
  data,
  busy,
  run,
  domain,
  setDomain,
}: {
  data: RegulatoryPayload;
  busy: string | null;
  run: RunFn;
  domain: string;
  setDomain: (value: string) => void;
}) {
  const available = SETTING_DOMAIN_ORDER.filter((item) =>
    data.settings.some((setting) => setting.domain === item),
  );
  const tabs = [...available, "integrations", "statutory"] as string[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Setting domains">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={domain === item}
            onClick={() => setDomain(item)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium",
              domain === item
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {SETTING_DOMAIN_LABELS[item] ?? item}
          </button>
        ))}
      </div>

      {domain === "integrations" ? (
        <IntegrationsSection data={data} busy={busy} run={run} />
      ) : domain === "statutory" ? (
        <StatutorySection data={data} busy={busy} run={run} />
      ) : (
        <SettingsList
          settings={data.settings.filter((setting) => setting.domain === domain)}
          busy={busy}
          run={run}
        />
      )}
    </div>
  );
}

function SettingsList({
  settings,
  busy,
  run,
}: {
  settings: SettingRow[];
  busy: string | null;
  run: RunFn;
}) {
  return (
    <Panel
      title="Facility settings"
      description="Each value is validated server-side. Changes are effective-dated and audited."
      testId="regulatory-settings"
    >
      <div className="divide-y divide-border">
        {settings.map((setting) => (
          <SettingField key={`${setting.domain}:${setting.key}`} setting={setting} busy={busy} run={run} />
        ))}
      </div>
    </Panel>
  );
}

function SettingField({
  setting,
  busy,
  run,
}: {
  setting: SettingRow;
  busy: string | null;
  run: RunFn;
}) {
  const [value, setValue] = useState<FieldValue>(setting.displayValue);

  useEffect(() => {
    setValue(setting.displayValue);
  }, [setting.displayValue]);

  const fieldId = `setting-${setting.domain}-${setting.key}`;
  const disabled = busy !== null;

  function submit() {
    const payload =
      setting.dataType === "integer" || setting.dataType === "decimal"
        ? value === ""
          ? null
          : Number(value)
        : setting.dataType === "boolean"
          ? Boolean(value)
          : value;
    void run(
      `setting-${setting.key}`,
      "upsertFacilitySetting",
      { domain: setting.domain, key: setting.key, value: payload },
      `${setting.label} saved.`,
    );
  }

  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[1fr_260px] sm:items-start" data-testid={`setting-row-${setting.key}`}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={fieldId} className="text-sm font-medium">
            {setting.label}
          </Label>
          {setting.missing ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Missing
            </span>
          ) : null}
          {setting.isSecret ? (
            <span className="rounded-md bg-[var(--status-info-background)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--status-info-foreground)]">
              Reference only
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{setting.description}</p>
        <p className="font-mono text-[10px] text-muted-foreground">
          {setting.domain}.{setting.key} · effective {setting.effectiveFrom}
          {setting.updatedBy ? ` · last changed by ${setting.updatedBy}` : " · seeded default"}
        </p>
      </div>

      <div className="flex items-start gap-2">
        {setting.dataType === "enum" && setting.allowedValues ? (
          <select
            id={fieldId}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            data-testid={`setting-input-${setting.key}`}
          >
            <option value="">Select…</option>
            {setting.allowedValues.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : setting.dataType === "boolean" ? (
          <label className="flex h-8 items-center gap-2 text-sm">
            <input
              id={fieldId}
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={Boolean(value)}
              disabled={disabled}
              onChange={(event) => setValue(event.target.checked)}
              data-testid={`setting-input-${setting.key}`}
            />
            <span className="text-muted-foreground">{value ? "On" : "Off"}</span>
          </label>
        ) : (
          <Input
            id={fieldId}
            type={setting.dataType === "integer" || setting.dataType === "decimal" ? "number" : "text"}
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            data-testid={`setting-input-${setting.key}`}
          />
        )}
        <Button size="sm" disabled={disabled} onClick={submit}>
          Save
        </Button>
      </div>
    </div>
  );
}

function IntegrationsSection({ data, busy, run }: { data: RegulatoryPayload; busy: string | null; run: RunFn }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel
        title="Integration endpoints"
        description="Sandbox and production are separate rows. Only a credential reference is stored."
        testId="regulatory-integrations"
      >
        <DataTable
          rows={data.integrations}
          testId="regulatory-integration-table"
          empty="No integration configured yet."
          columns={[
            { key: "integration", label: "Integration", render: (row) => row.integration },
            { key: "env", label: "Environment", render: (row) => row.environment },
            { key: "url", label: "Base URL", render: (row) => row.baseUrl ?? "—" },
            { key: "ref", label: "Credential ref", render: (row) => row.credentialRef ?? "—" },
            {
              key: "verified",
              label: "Last verified",
              render: (row) => (row.lastVerifiedAt ? row.lastVerifiedAt.slice(0, 10) : "Never"),
            },
            {
              key: "action",
              label: "",
              render: (row) => (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      `verify-${row.id}`,
                      "verifyIntegrationConnection",
                      { integration: row.integration, environment: row.environment },
                      "Connection verified.",
                    )
                  }
                >
                  Test
                </Button>
              ),
            },
          ]}
        />
      </Panel>

      <Panel title="Add an endpoint" description="The secret itself never enters the database." testId="regulatory-integration-form">
        <RecordForm
          testId="regulatory-integration-new"
          submitLabel="Save endpoint"
          busy={busy}
          fields={[
            {
              name: "integration",
              label: "Integration",
              type: "select",
              required: true,
              options: ["etims", "khis", "sha_portal", "sms", "payments"].map((value) => ({
                value,
                label: value,
              })),
            },
            {
              name: "environment",
              label: "Environment",
              type: "select",
              required: true,
              options: ["sandbox", "production"].map((value) => ({ value, label: value })),
            },
            { name: "baseUrl", label: "Base URL", full: true, placeholder: "https://" },
            { name: "mode", label: "Mode", placeholder: "oscu" },
            { name: "credentialRef", label: "Credential reference", required: true, placeholder: "ETIMS_CLIENT_SECRET" },
            { name: "enabled", label: "Enabled", type: "checkbox", placeholder: "Enable this endpoint" },
          ]}
          onSubmit={async (values) => {
            const ok = await run(
              "integration",
              "upsertIntegrationSetting",
              {
                integration: values.integration,
                environment: values.environment,
                baseUrl: values.baseUrl || undefined,
                mode: values.mode || undefined,
                credentialRef: values.credentialRef,
                enabled: Boolean(values.enabled),
              },
              "Integration endpoint saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>
    </div>
  );
}

function StatutorySection({ data, busy, run }: { data: RegulatoryPayload; busy: string | null; run: RunFn }) {
  return (
    <div className="space-y-4">
      <Panel
        title="Statutory rates"
        description="PAYE bands, NSSF tiers, SHIF and the housing levy. A change appends a row."
        testId="regulatory-rates"
      >
        <DataTable
          rows={data.rates}
          testId="regulatory-rate-table"
          empty="No statutory rate recorded yet."
          columns={[
            { key: "type", label: "Type", render: (row) => row.rateType },
            { key: "band", label: "Band", render: (row) => row.bandOrder },
            {
              key: "bounds",
              label: "Range",
              render: (row) => `${row.lowerBound} – ${row.upperBound ?? "∞"}`,
            },
            { key: "rate", label: "Rate %", render: (row) => row.ratePercent },
            { key: "from", label: "From", render: (row) => row.effectiveFrom },
          ]}
        />
        <RecordForm
          testId="regulatory-rate-new"
          submitLabel="Add rate"
          busy={busy}
          fields={[
            {
              name: "rateType",
              label: "Rate type",
              type: "select",
              required: true,
              options: ["paye_band", "nssf_tier", "shif", "housing_levy", "other"].map((value) => ({
                value,
                label: value.replaceAll("_", " "),
              })),
            },
            { name: "bandOrder", label: "Band order", type: "number", required: true },
            { name: "lowerBound", label: "Lower bound", required: true },
            { name: "upperBound", label: "Upper bound" },
            { name: "ratePercent", label: "Rate %", type: "number", required: true },
            { name: "effectiveFrom", label: "Effective from", required: true, placeholder: "YYYY-MM-DD" },
          ]}
          onSubmit={async (values) => {
            const ok = await run(
              "rate",
              "upsertStatutoryRate",
              {
                rateType: values.rateType,
                bandOrder: Number(values.bandOrder),
                lowerBound: values.lowerBound,
                upperBound: values.upperBound || undefined,
                ratePercent: Number(values.ratePercent),
                effectiveFrom: toIsoDate(values.effectiveFrom),
              },
              "Statutory rate saved.",
            );
            if (!ok) return;
          }}
        />
      </Panel>

      <Panel
        title="Statutory fees"
        description="Licence and renewal fees with the regulator page they came from."
        testId="regulatory-fees"
      >
        <DataTable
          rows={data.fees}
          testId="regulatory-fee-table"
          empty="No statutory fee recorded yet."
          columns={[
            { key: "authority", label: "Authority", render: (row) => row.authority },
            { key: "category", label: "Category", render: (row) => row.category },
            { key: "amount", label: "Amount", render: (row) => `${row.currency} ${row.amount}` },
            { key: "from", label: "From", render: (row) => row.effectiveFrom },
          ]}
        />
      </Panel>

      <Panel
        title="SHA adjudication codes"
        description="How the payer's response codes map onto the claim workflow."
        testId="regulatory-sha-codes"
      >
        <DataTable
          rows={data.shaCodes}
          testId="regulatory-sha-table"
          empty="No SHA adjudication code recorded yet."
          columns={[
            { key: "code", label: "Code", render: (row) => row.code },
            { key: "description", label: "Description", render: (row) => row.description },
            { key: "category", label: "Category", render: (row) => row.category },
            { key: "retryable", label: "Retryable", render: (row) => (row.retryable ? "Yes" : "No") },
          ]}
        />
      </Panel>
    </div>
  );
}
