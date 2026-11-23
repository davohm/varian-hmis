"use client";

import {
  AlertTriangle,
  BadgeCheck,
  CircleDollarSign,
  FileClock,
  FileText,
  Printer,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  SubHeading,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import { LoadingPanel } from "@/components/ui/loading-panel";

import { ShaClaimDocument, ShaRemittanceDocument } from "./sha-documents";
import {
  formatDate,
  formatMoney,
  monthStartIso,
  postShaCommand,
  SHA_TABS,
  STATUS_TONE,
  todayIso,
  type BenefitPackageItemRow,
  type ShaCapabilities,
  type ShaClaimDetail,
  type ShaData,
  type ShaTab,
} from "./sha-types";

const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[var(--brand-navy)] px-3 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const SMALL_BUTTON_CLASS =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

const EMPTY_DATA: ShaData = {
  empanelments: [],
  benefitPackages: [],
  eligibilityChecks: [],
  preAuthorizations: [],
  claims: [],
  claimDetail: null,
  remittances: [],
  waivers: [],
  reconciliations: [],
  reconciliation: null,
  adjudicationCodes: [],
  ageing: [],
  coverage: null,
  benefitPackage: null,
  payers: [],
  contracts: [],
  encounters: [],
  patients: [],
};

type RunCommand = <T>(
  command: string,
  input: Record<string, unknown>,
  success: string,
) => Promise<T | null>;

interface PanelProps {
  data: ShaData;
  capabilities: ShaCapabilities;
  run: RunCommand;
  refresh: () => Promise<void>;
  selectedClaimId: string;
  selectClaim: (id: string) => void;
  selectedPatientId: string;
  selectPatient: (id: string) => void;
  selectedPackageId: string;
  selectPackage: (id: string) => void;
  selectedReconciliationId: string;
  selectReconciliation: (id: string) => void;
  patientQuery: string;
  setPatientQuery: (query: string) => void;
  setDocument: (document: "claim" | "remittance" | null) => void;
}

function newKey(): string {
  return crypto.randomUUID();
}

function Pill({ value }: { value: string | null | undefined }) {
  return <StatusPill tone={STATUS_TONE[value ?? ""] ?? "neutral"}>{value ?? "—"}</StatusPill>;
}

function Kpi({
  label,
  value,
  helper,
  icon,
  testId,
  tone,
}: {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  testId: string;
  tone?: "success" | "danger" | "warning";
}) {
  const toneClass =
    tone === "danger"
      ? "bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
      : tone === "success"
        ? "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
        : tone === "warning"
          ? "bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
          : "bg-secondary text-primary";
  return (
    <div data-testid={testId} className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${toneClass}`} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="mt-0.5 truncate font-mono text-base font-semibold tabular-nums text-foreground">
          {value}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{helper}</p>
      </div>
    </div>
  );
}

function StatusForm({
  empanelmentId,
  current,
  canSetup,
  run,
}: {
  empanelmentId: string;
  current: string;
  canSetup: boolean;
  run: RunCommand;
}) {
  const [status, setStatus] = useState(current);
  const [reason, setReason] = useState("");

  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          "updateEmpanelmentStatus",
          { empanelmentId, status, reason: reason || null, idempotencyKey: newKey() },
          "Empanelment status updated",
        );
      }}
    >
      <select
        aria-label="Empanelment status"
        value={status}
        onChange={(event) => setStatus(event.target.value)}
        className={`${INPUT_CLASS} h-7 w-28 px-2 text-xs`}
        disabled={!canSetup}
      >
        {["active", "suspended", "expired", "terminated"].map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <input
        aria-label="Closure reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className={`${INPUT_CLASS} h-7 w-32 px-2 text-xs`}
        placeholder="Reason"
        disabled={!canSetup}
      />
      <button type="submit" className={SMALL_BUTTON_CLASS} disabled={!canSetup}>
        Update
      </button>
    </form>
  );
}

function EmpanelmentPanel({ data, capabilities, run, selectPackage }: PanelProps) {
  const [form, setForm] = useState({
    kmpdcNumber: data.empanelments[0]?.kmpdcNumber ?? "",
    fund: "shif",
    schemeCode: "",
    schemeName: "",
    contractNo: "",
    effectiveFrom: todayIso(),
    expiryDate: "",
    tariffVersion: "",
    qualityCertProgram: "",
    qualityCertExpiry: "",
  });
  const [packageForm, setPackageForm] = useState({
    fund: "shif",
    packageCode: "",
    name: "",
    careLevel: "",
    careType: "outpatient",
    effectiveFrom: todayIso(),
    effectiveTo: "",
  });
  const [items, setItems] = useState([
    {
      shaServiceCode: "",
      description: "",
      coverage: "full",
      unitPrice: "0",
      coPayPercent: "0",
      preauthThreshold: "",
      requiresPreauth: false,
    },
  ]);

  const updateItem = (index: number, patch: Record<string, unknown>) => {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  return (
    <div className="space-y-4">
      <Panel
        title="SHA empanelments"
        description="One row per facility, fund and scheme. KMPDC and licence status are verified by the command."
        testId="sha-empanelment-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA empanelments</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Fund / scheme</th>
                <th scope="col" className={TH_CLASS}>KMPDC</th>
                <th scope="col" className={TH_CLASS}>Contract</th>
                <th scope="col" className={TH_CLASS}>Period</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.empanelments.length === 0 ? (
                <EmptyRow colSpan={6} message="No empanelment has been recorded for this facility." />
              ) : (
                data.empanelments.map((row) => (
                  <tr key={row.id}>
                    <td className={TD_CLASS}>
                      <span className="font-medium">{row.fund.toUpperCase()}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.schemeCode}
                        {row.schemeName ? ` · ${row.schemeName}` : ""}
                      </span>
                    </td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.kmpdcNumber ?? "—"}</td>
                    <td className={TD_CLASS}>{row.contractNo ?? "—"}</td>
                    <td className={`${TD_CLASS} text-xs`}>
                      {row.effectiveFrom} → {row.expiryDate ?? "open"}
                    </td>
                    <td className={TD_CLASS}><Pill value={row.contractStatus} /></td>
                    <td className={TD_CLASS}>
                      <StatusForm
                        empanelmentId={row.id}
                        current={row.contractStatus}
                        canSetup={capabilities.canSetup}
                        run={run}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {capabilities.canSetup ? (
        <Panel
          title="Add empanelment"
          description="Regulator values are entered by an authorised user; nothing is inferred."
          testId="sha-empanelment-form"
        >
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "createEmpanelment",
                { ...form, expiryDate: form.expiryDate || null, idempotencyKey: newKey() },
                "SHA empanelment created",
              );
            }}
          >
            <Field label="KMPDC number" hint="Verified against the facility regulatory profile">
              <input
                className={INPUT_CLASS}
                value={form.kmpdcNumber}
                onChange={(event) => setForm({ ...form, kmpdcNumber: event.target.value })}
                required
              />
            </Field>
            <Field label="Fund">
              <select
                className={INPUT_CLASS}
                value={form.fund}
                onChange={(event) => setForm({ ...form, fund: event.target.value })}
              >
                {["phf", "shif", "eccif"].map((fund) => (
                  <option key={fund} value={fund}>{fund.toUpperCase()}</option>
                ))}
              </select>
            </Field>
            <Field label="Scheme code">
              <input
                className={INPUT_CLASS}
                value={form.schemeCode}
                onChange={(event) => setForm({ ...form, schemeCode: event.target.value })}
                required
              />
            </Field>
            <Field label="Scheme name">
              <input
                className={INPUT_CLASS}
                value={form.schemeName}
                onChange={(event) => setForm({ ...form, schemeName: event.target.value })}
              />
            </Field>
            <Field label="Contract number">
              <input
                className={INPUT_CLASS}
                value={form.contractNo}
                onChange={(event) => setForm({ ...form, contractNo: event.target.value })}
              />
            </Field>
            <Field label="Effective from">
              <input
                type="date"
                className={INPUT_CLASS}
                value={form.effectiveFrom}
                onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
                required
              />
            </Field>
            <Field label="Expiry date">
              <input
                type="date"
                className={INPUT_CLASS}
                value={form.expiryDate}
                onChange={(event) => setForm({ ...form, expiryDate: event.target.value })}
              />
            </Field>
            <Field label="Tariff version">
              <input
                className={INPUT_CLASS}
                value={form.tariffVersion}
                onChange={(event) => setForm({ ...form, tariffVersion: event.target.value })}
              />
            </Field>
            <Field label="Quality certification programme">
              <input
                className={INPUT_CLASS}
                value={form.qualityCertProgram}
                onChange={(event) => setForm({ ...form, qualityCertProgram: event.target.value })}
              />
            </Field>
            <Field label="Quality certificate expiry">
              <input
                type="date"
                className={INPUT_CLASS}
                value={form.qualityCertExpiry}
                onChange={(event) => setForm({ ...form, qualityCertExpiry: event.target.value })}
              />
            </Field>
            <div className="flex items-end sm:col-span-2 lg:col-span-4">
              <button type="submit" className={PRIMARY_BUTTON_CLASS}>Create empanelment</button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Benefit packages and tariffs"
        description="Fund-specific packages are the pricing source for claim lines."
        testId="sha-benefit-package-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA benefit packages</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Package</th>
                <th scope="col" className={TH_CLASS}>Fund</th>
                <th scope="col" className={TH_CLASS}>Care</th>
                <th scope="col" className={TH_CLASS}>Period</th>
                <th scope="col" className={TH_CLASS}>Items</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.benefitPackages.length === 0 ? (
                <EmptyRow colSpan={6} message="No benefit packages have been configured." />
              ) : (
                data.benefitPackages.map((row) => (
                  <tr key={row.id}>
                    <td className={TD_CLASS}>
                      <span className="font-medium">{row.packageCode}</span>
                      <span className="block text-xs text-muted-foreground">{row.name}</span>
                    </td>
                    <td className={TD_CLASS}>{row.fund.toUpperCase()}</td>
                    <td className={TD_CLASS}>{row.careType}</td>
                    <td className={`${TD_CLASS} text-xs`}>
                      {row.effectiveFrom} → {row.effectiveTo ?? "open"}
                    </td>
                    <td className={`${TD_CLASS} font-mono`}>{row.items.length}</td>
                    <td className={TD_CLASS}>
                      <button
                        type="button"
                        className={SMALL_BUTTON_CLASS}
                        onClick={() => selectPackage(row.id)}
                      >
                        View items
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {data.benefitPackage ? (
          <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3" data-testid="sha-benefit-package-detail">
            <SubHeading
              title={`${data.benefitPackage.packageCode} · ${data.benefitPackage.name}`}
              description="Coverage and co-pay are applied per line when a claim is built."
            />
            <div className="mt-3 overflow-x-auto">
              <table className={TABLE_CLASS}>
                <caption className="sr-only">Benefit package items</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH_CLASS}>Code</th>
                    <th scope="col" className={TH_CLASS}>Description</th>
                    <th scope="col" className={TH_CLASS}>Coverage</th>
                    <th scope="col" className={TH_CLASS}>Unit price</th>
                    <th scope="col" className={TH_CLASS}>Co-pay %</th>
                    <th scope="col" className={TH_CLASS}>Pre-auth</th>
                  </tr>
                </thead>
                <tbody>
                  {data.benefitPackage.items.map((item) => (
                    <tr key={item.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{item.shaServiceCode ?? "—"}</td>
                      <td className={TD_CLASS}>{item.description ?? item.category ?? "—"}</td>
                      <td className={TD_CLASS}><Pill value={item.coverage} /></td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(item.unitPrice)}</td>
                      <td className={`${TD_CLASS} text-right`}>{item.coPayPercent}%</td>
                      <td className={TD_CLASS}>
                        {item.requiresPreauth || item.preauthThreshold ? "Required" : "No"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Panel>

      {capabilities.canSetup ? (
        <Panel
          title="Create benefit package"
          description="Tariff values and exclusions are entered here; excluded lines must be marked patient-pay on a claim."
          testId="sha-benefit-package-form"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "createBenefitPackage",
                {
                  ...packageForm,
                  effectiveTo: packageForm.effectiveTo || null,
                  careLevel: packageForm.careLevel || null,
                  items: items.map((item) => ({
                    shaServiceCode: item.shaServiceCode || null,
                    description: item.description || null,
                    coverage: item.coverage,
                    unitPrice: item.unitPrice,
                    coPayPercent: Number(item.coPayPercent),
                    requiresPreauth: item.requiresPreauth,
                    preauthThreshold: item.preauthThreshold ? item.preauthThreshold : null,
                  })),
                  idempotencyKey: newKey(),
                },
                "Benefit package created",
              );
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Fund">
                <select
                  className={INPUT_CLASS}
                  value={packageForm.fund}
                  onChange={(event) => setPackageForm({ ...packageForm, fund: event.target.value })}
                >
                  {["phf", "shif", "eccif"].map((fund) => (
                    <option key={fund} value={fund}>{fund.toUpperCase()}</option>
                  ))}
                </select>
              </Field>
              <Field label="Package code">
                <input
                  className={INPUT_CLASS}
                  value={packageForm.packageCode}
                  onChange={(event) => setPackageForm({ ...packageForm, packageCode: event.target.value })}
                  required
                />
              </Field>
              <Field label="Name">
                <input
                  className={INPUT_CLASS}
                  value={packageForm.name}
                  onChange={(event) => setPackageForm({ ...packageForm, name: event.target.value })}
                  required
                />
              </Field>
              <Field label="Care type">
                <select
                  className={INPUT_CLASS}
                  value={packageForm.careType}
                  onChange={(event) => setPackageForm({ ...packageForm, careType: event.target.value })}
                >
                  <option value="outpatient">Outpatient</option>
                  <option value="inpatient">Inpatient</option>
                </select>
              </Field>
              <Field label="Care level">
                <input
                  className={INPUT_CLASS}
                  value={packageForm.careLevel}
                  onChange={(event) => setPackageForm({ ...packageForm, careLevel: event.target.value })}
                />
              </Field>
              <Field label="Effective from">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={packageForm.effectiveFrom}
                  onChange={(event) => setPackageForm({ ...packageForm, effectiveFrom: event.target.value })}
                  required
                />
              </Field>
              <Field label="Effective to">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={packageForm.effectiveTo}
                  onChange={(event) => setPackageForm({ ...packageForm, effectiveTo: event.target.value })}
                />
              </Field>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">Benefit lines</h4>
                <button
                  type="button"
                  className={SMALL_BUTTON_CLASS}
                  onClick={() =>
                    setItems((current) => [
                      ...current,
                      {
                        shaServiceCode: "",
                        description: "",
                        coverage: "full",
                        unitPrice: "0",
                        coPayPercent: "0",
                        preauthThreshold: "",
                        requiresPreauth: false,
                      },
                    ])
                  }
                >
                  Add line
                </button>
              </div>
              {items.map((item, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                  <Field label="SHA code">
                    <input
                      className={INPUT_CLASS}
                      value={item.shaServiceCode}
                      onChange={(event) => updateItem(index, { shaServiceCode: event.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Description">
                    <input
                      className={INPUT_CLASS}
                      value={item.description}
                      onChange={(event) => updateItem(index, { description: event.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Coverage">
                    <select
                      className={INPUT_CLASS}
                      value={item.coverage}
                      onChange={(event) => updateItem(index, { coverage: event.target.value })}
                    >
                      <option value="full">Full</option>
                      <option value="partial">Partial</option>
                      <option value="excluded">Excluded</option>
                    </select>
                  </Field>
                  <Field label="Unit price">
                    <input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      value={item.unitPrice}
                      onChange={(event) => updateItem(index, { unitPrice: event.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Co-pay %">
                    <input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      value={item.coPayPercent}
                      onChange={(event) => updateItem(index, { coPayPercent: event.target.value })}
                    />
                  </Field>
                  <Field label="Pre-auth threshold">
                    <input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      value={item.preauthThreshold}
                      onChange={(event) => updateItem(index, { preauthThreshold: event.target.value })}
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-xs text-foreground sm:col-span-2 lg:col-span-3">
                    <input
                      type="checkbox"
                      checked={item.requiresPreauth}
                      onChange={(event) => updateItem(index, { requiresPreauth: event.target.checked })}
                    />
                    Requires pre-authorisation
                  </label>
                  {items.length > 1 ? (
                    <button
                      type="button"
                      className={`${SMALL_BUTTON_CLASS} w-fit`}
                      onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                    >
                      Remove line
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <button type="submit" className={PRIMARY_BUTTON_CLASS}>Create benefit package</button>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}

function PatientLookup({ data, selectedPatientId, selectPatient, patientQuery, setPatientQuery, refresh }: PanelProps) {
  const [query, setQuery] = useState(patientQuery);
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPatientQuery(query.trim());
          void refresh();
        }}
      >
        <Field label="Find patient" className="min-w-56 flex-1">
          <input
            className={INPUT_CLASS}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, MRN or phone"
            aria-label="Search patients for SHA work"
          />
        </Field>
        <button type="submit" className={BUTTON_CLASS}>Search</button>
      </form>
      {data.patients.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Patient search results">
          {data.patients.map((patient) => (
            <button
              key={patient.id}
              type="button"
              className={`${SMALL_BUTTON_CLASS} ${selectedPatientId === patient.id ? "border-[var(--brand-mint)] bg-secondary" : ""}`}
              onClick={() => selectPatient(patient.id)}
            >
              {patient.lastName}, {patient.firstName} · {patient.mrn}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {patientQuery ? "No patients matched that search." : "Search to load patients for eligibility, claims and authorisations."}
        </p>
      )}
    </div>
  );
}

function EligibilityPanel(props: PanelProps) {
  const { data, capabilities, run, selectedPatientId, selectPatient } = props;
  const [form, setForm] = useState({
    patientId: selectedPatientId,
    fund: "shif",
    empanelmentId: "",
    memberRef: "",
    eligibility: "eligible",
    checkRef: "",
    notes: "",
  });
  const [waiver, setWaiver] = useState({ kind: "waiver", claimId: "", amount: "", reason: "" });

  useEffect(() => {
    setForm((current) => ({ ...current, patientId: selectedPatientId }));
  }, [selectedPatientId]);

  const coverage = data.coverage;
  const activePackage = coverage?.packages[0];

  return (
    <div className="space-y-4">
      <PatientLookup {...props} />

      <Panel
        title="Eligibility verification"
        description="Cashier or revenue staff record the eligibility response and member reference before a claim is built."
        testId="sha-eligibility-panel"
      >
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "verifyShaEligibility",
              {
                ...form,
                empanelmentId: form.empanelmentId || null,
                memberRef: form.memberRef || null,
                checkRef: form.checkRef || null,
                notes: form.notes || null,
                idempotencyKey: newKey(),
              },
              "Eligibility check recorded",
            );
          }}
        >
          <Field label="Patient">
            <select
              className={INPUT_CLASS}
              value={form.patientId}
              onChange={(event) => {
                setForm({ ...form, patientId: event.target.value });
                selectPatient(event.target.value);
              }}
              required
            >
              <option value="">Select a patient</option>
              {data.patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.mrn} · {patient.firstName} {patient.lastName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fund">
            <select
              className={INPUT_CLASS}
              value={form.fund}
              onChange={(event) => setForm({ ...form, fund: event.target.value })}
            >
              {["phf", "shif", "eccif"].map((fund) => (
                <option key={fund} value={fund}>{fund.toUpperCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Empanelment">
            <select
              className={INPUT_CLASS}
              value={form.empanelmentId}
              onChange={(event) => setForm({ ...form, empanelmentId: event.target.value })}
            >
              <option value="">Not linked</option>
              {data.empanelments.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.fund.toUpperCase()} · {row.schemeCode}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Eligibility">
            <select
              className={INPUT_CLASS}
              value={form.eligibility}
              onChange={(event) => setForm({ ...form, eligibility: event.target.value })}
            >
              <option value="eligible">Eligible</option>
              <option value="unknown">Unknown</option>
              <option value="ineligible">Ineligible</option>
            </select>
          </Field>
          <Field label="Member reference">
            <input
              className={INPUT_CLASS}
              value={form.memberRef}
              onChange={(event) => setForm({ ...form, memberRef: event.target.value })}
            />
          </Field>
          <Field label="Check reference">
            <input
              className={INPUT_CLASS}
              value={form.checkRef}
              onChange={(event) => setForm({ ...form, checkRef: event.target.value })}
            />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <input
              className={INPUT_CLASS}
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <button
              type="submit"
              className={PRIMARY_BUTTON_CLASS}
              disabled={!capabilities.canVerifyEligibility || !form.patientId}
            >
              Record check
            </button>
          </div>
        </form>
      </Panel>

      {coverage ? (
        <Panel
          title={`Coverage snapshot · ${coverage.patient.name}`}
          description="Latest eligibility and the co-pay applied to each benefit line."
          testId="sha-coverage-preview"
        >
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <Pill value={coverage.eligibility?.eligibility ?? "unknown"} />
            <span className="text-muted-foreground">
              Member: <span className="font-mono text-foreground">{coverage.patient.payerMemberNo ?? "—"}</span>
            </span>
            <span className="text-muted-foreground">
              Checked: {coverage.eligibility ? formatDate(coverage.eligibility.checkedAt) : "never"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <caption className="sr-only">Patient benefit coverage</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>SHA code</th>
                  <th scope="col" className={TH_CLASS}>Service</th>
                  <th scope="col" className={TH_CLASS}>Coverage</th>
                  <th scope="col" className={TH_CLASS}>Unit price</th>
                  <th scope="col" className={TH_CLASS}>Co-pay %</th>
                  <th scope="col" className={TH_CLASS}>Pre-auth</th>
                </tr>
              </thead>
              <tbody>
                {(activePackage?.items ?? []).length === 0 ? (
                  <EmptyRow colSpan={6} message="No active benefit package for this fund." />
                ) : (
                  activePackage?.items.map((item: BenefitPackageItemRow) => (
                    <tr key={item.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{item.shaServiceCode ?? "—"}</td>
                      <td className={TD_CLASS}>{item.description ?? item.category ?? "—"}</td>
                      <td className={TD_CLASS}><Pill value={item.coverage} /></td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(item.unitPrice)}</td>
                      <td className={`${TD_CLASS} text-right`}>{item.coPayPercent}%</td>
                      <td className={TD_CLASS}>{item.requiresPreauth || item.preauthThreshold ? "Required" : "No"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Eligibility history"
        description="Every check is retained as an audited event."
        testId="sha-eligibility-history"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA eligibility checks</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>When</th>
                <th scope="col" className={TH_CLASS}>Patient</th>
                <th scope="col" className={TH_CLASS}>Fund</th>
                <th scope="col" className={TH_CLASS}>Reference</th>
                <th scope="col" className={TH_CLASS}>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.eligibilityChecks.length === 0 ? (
                <EmptyRow colSpan={5} message="No eligibility checks recorded." />
              ) : (
                data.eligibilityChecks.map((check) => (
                  <tr key={check.id}>
                    <td className={`${TD_CLASS} text-xs`}>{formatDate(check.checkedAt)}</td>
                    <td className={TD_CLASS}>
                      {data.patients.find((patient) => patient.id === check.patientId)
                        ? `${data.patients.find((patient) => patient.id === check.patientId)!.lastName}, ${data.patients.find((patient) => patient.id === check.patientId)!.firstName}`
                        : check.patientId.slice(0, 8)}
                    </td>
                    <td className={TD_CLASS}>{check.fund?.toUpperCase() ?? "—"}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{check.checkRef ?? check.memberRef ?? "—"}</td>
                    <td className={TD_CLASS}><Pill value={check.eligibility} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {capabilities.canVerifyEligibility ? (
          <Panel title="Request a waiver or exemption" description="A separate approver must decide the request." testId="sha-waiver-form">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  "requestShaWaiver",
                  {
                    ...waiver,
                    claimId: waiver.claimId || null,
                    amount: waiver.amount,
                    idempotencyKey: newKey(),
                  },
                  "Waiver request recorded",
                );
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Kind">
                  <select
                    className={INPUT_CLASS}
                    value={waiver.kind}
                    onChange={(event) => setWaiver({ ...waiver, kind: event.target.value })}
                  >
                    <option value="waiver">Waiver</option>
                    <option value="exemption">Exemption</option>
                  </select>
                </Field>
                <Field label="Claim">
                  <select
                    className={INPUT_CLASS}
                    value={waiver.claimId}
                    onChange={(event) => setWaiver({ ...waiver, claimId: event.target.value })}
                    required
                  >
                    <option value="">Select claim</option>
                    {data.claims.map((claim) => (
                      <option key={claim.id} value={claim.id}>
                        {claim.claimNo} · {claim.patientName}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount">
                  <input
                    className={INPUT_CLASS}
                    inputMode="decimal"
                    value={waiver.amount}
                    onChange={(event) => setWaiver({ ...waiver, amount: event.target.value })}
                    required
                  />
                </Field>
              </div>
              <Field label="Reason">
                <textarea
                  className={`${INPUT_CLASS} h-20 py-2`}
                  value={waiver.reason}
                  onChange={(event) => setWaiver({ ...waiver, reason: event.target.value })}
                  required
                />
              </Field>
              <button type="submit" className={PRIMARY_BUTTON_CLASS}>Request waiver</button>
            </form>
          </Panel>
        ) : null}

        <Panel title="Waivers and exemptions" description="Approval is restricted to finance or administration." testId="sha-waiver-list">
          <div className="space-y-2">
            {data.waivers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No waivers or exemptions recorded.</p>
            ) : (
              data.waivers.map((row) => (
                <div key={row.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium capitalize">{row.kind}</span>
                      <Pill value={row.status} />
                      <span className="font-mono text-sm">{formatMoney(row.amount)}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{row.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.claimNo ?? row.invoiceNo ?? "Unlinked"} · requested by {row.requestedBy.slice(0, 8)}
                    </p>
                  </div>
                  {capabilities.canApprove && row.status === "requested" ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={SMALL_BUTTON_CLASS}
                        onClick={() =>
                          void run(
                            row.kind === "exemption" ? "approveExemption" : "approveWaiver",
                            { waiverId: row.id, decision: "approved", idempotencyKey: newKey() },
                            "Waiver approved",
                          )
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className={SMALL_BUTTON_CLASS}
                        onClick={() =>
                          void run(
                            row.kind === "exemption" ? "approveExemption" : "approveWaiver",
                            { waiverId: row.id, decision: "rejected", idempotencyKey: newKey() },
                            "Waiver rejected",
                          )
                        }
                      >
                        Reject
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PreAuthorizationPanel({ data, capabilities, run }: PanelProps) {
  const [form, setForm] = useState({
    patientId: "",
    payerId: "",
    empanelmentId: "",
    benefitPackageId: "",
    fund: "shif",
    requestedAmount: "",
    shaAuthRef: "",
    expiresAt: "",
    notes: "",
  });
  const [decision, setDecision] = useState({
    preAuthId: "",
    decision: "approved",
    approvedAmount: "",
    shaAuthRef: "",
    note: "",
  });
  const packages = data.benefitPackages.filter((item) => item.fund === form.fund);
  const encounters = data.encounters.filter((row) => row.patientId === form.patientId);

  return (
    <div className="space-y-4">
      <Panel title="SHA pre-authorisations" description="Guarantees are requested before high-cost or threshold lines are claimed." testId="sha-preauth-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA pre-authorisations</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Auth no.</th>
                <th scope="col" className={TH_CLASS}>Patient</th>
                <th scope="col" className={TH_CLASS}>Fund</th>
                <th scope="col" className={TH_CLASS}>Requested</th>
                <th scope="col" className={TH_CLASS}>Approved</th>
                <th scope="col" className={TH_CLASS}>Expires</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.preAuthorizations.length === 0 ? (
                <EmptyRow colSpan={7} message="No SHA pre-authorisations recorded." />
              ) : (
                data.preAuthorizations.map((row) => (
                  <tr key={row.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>
                      {row.shaAuthRef ?? row.authNo}
                      <span className="block text-[10px] text-muted-foreground">{row.authNo}</span>
                    </td>
                    <td className={TD_CLASS}>{row.patientName}</td>
                    <td className={TD_CLASS}>{row.fund?.toUpperCase() ?? "—"}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.requestedAmount)}</td>
                    <td className={`${TD_CLASS} text-right`}>{row.approvedAmount ? formatMoney(row.approvedAmount) : "—"}</td>
                    <td className={`${TD_CLASS} text-xs`}>{row.expiresAt ?? "—"}</td>
                    <td className={TD_CLASS}><Pill value={row.status} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {capabilities.canClaim ? (
        <Panel title="Request pre-authorisation" description="The requester cannot approve their own authorisation." testId="sha-preauth-form">
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "requestShaPreAuthorization",
                {
                  ...form,
                  empanelmentId: form.empanelmentId,
                  benefitPackageId: form.benefitPackageId || null,
                  shaAuthRef: form.shaAuthRef || null,
                  expiresAt: form.expiresAt || null,
                  notes: form.notes || null,
                  encounterId: encounters[0]?.id ?? null,
                  idempotencyKey: newKey(),
                },
                "Pre-authorisation requested",
              );
            }}
          >
            <Field label="Patient">
              <select
                className={INPUT_CLASS}
                value={form.patientId}
                onChange={(event) => setForm({ ...form, patientId: event.target.value })}
                required
              >
                <option value="">Select patient</option>
                {data.patients.map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.mrn} · {patient.firstName} {patient.lastName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payer">
              <select
                className={INPUT_CLASS}
                value={form.payerId}
                onChange={(event) => setForm({ ...form, payerId: event.target.value })}
                required
              >
                <option value="">Select payer</option>
                {data.payers.map((payer) => (
                  <option key={payer.id} value={payer.id}>{payer.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Fund">
              <select
                className={INPUT_CLASS}
                value={form.fund}
                onChange={(event) => setForm({ ...form, fund: event.target.value, benefitPackageId: "" })}
              >
                {["phf", "shif", "eccif"].map((fund) => (
                  <option key={fund} value={fund}>{fund.toUpperCase()}</option>
                ))}
              </select>
            </Field>
            <Field label="Empanelment">
              <select
                className={INPUT_CLASS}
                value={form.empanelmentId}
                onChange={(event) => setForm({ ...form, empanelmentId: event.target.value })}
                required
              >
                <option value="">Select empanelment</option>
                {data.empanelments.filter((row) => row.fund === form.fund).map((row) => (
                  <option key={row.id} value={row.id}>{row.schemeCode} · {row.contractNo ?? "no contract"}</option>
                ))}
              </select>
            </Field>
            <Field label="Benefit package">
              <select
                className={INPUT_CLASS}
                value={form.benefitPackageId}
                onChange={(event) => setForm({ ...form, benefitPackageId: event.target.value })}
              >
                <option value="">Not linked</option>
                {packages.map((row) => (
                  <option key={row.id} value={row.id}>{row.packageCode} · {row.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Requested amount">
              <input
                className={INPUT_CLASS}
                inputMode="decimal"
                value={form.requestedAmount}
                onChange={(event) => setForm({ ...form, requestedAmount: event.target.value })}
                required
              />
            </Field>
            <Field label="SHA authorisation reference">
              <input
                className={INPUT_CLASS}
                value={form.shaAuthRef}
                onChange={(event) => setForm({ ...form, shaAuthRef: event.target.value })}
              />
            </Field>
            <Field label="Expiry">
              <input
                type="date"
                className={INPUT_CLASS}
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              />
            </Field>
            <Field label="Notes" className="sm:col-span-2 lg:col-span-4">
              <input
                className={INPUT_CLASS}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </Field>
            <div className="flex items-end sm:col-span-2 lg:col-span-4">
              <button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={!form.patientId || !form.payerId}>
                Request authorisation
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      {capabilities.canApprove ? (
        <Panel title="Decide pre-authorisation" description="A different signed-in user from the requester must decide." testId="sha-preauth-decision">
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "decideShaPreAuthorization",
                {
                  ...decision,
                  approvedAmount: decision.approvedAmount || null,
                  shaAuthRef: decision.shaAuthRef || null,
                  note: decision.note || null,
                  idempotencyKey: newKey(),
                },
                "Pre-authorisation decision recorded",
              );
            }}
          >
            <Field label="Authorisation">
              <select
                className={INPUT_CLASS}
                value={decision.preAuthId}
                onChange={(event) => setDecision({ ...decision, preAuthId: event.target.value })}
                required
              >
                <option value="">Select request</option>
                {data.preAuthorizations.filter((row) => row.status === "requested").map((row) => (
                  <option key={row.id} value={row.id}>{row.authNo} · {row.patientName}</option>
                ))}
              </select>
            </Field>
            <Field label="Decision">
              <select
                className={INPUT_CLASS}
                value={decision.decision}
                onChange={(event) => setDecision({ ...decision, decision: event.target.value })}
              >
                <option value="approved">Approved</option>
                <option value="declined">Declined</option>
              </select>
            </Field>
            <Field label="Approved amount">
              <input
                className={INPUT_CLASS}
                inputMode="decimal"
                value={decision.approvedAmount}
                onChange={(event) => setDecision({ ...decision, approvedAmount: event.target.value })}
              />
            </Field>
            <Field label="SHA reference">
              <input
                className={INPUT_CLASS}
                value={decision.shaAuthRef}
                onChange={(event) => setDecision({ ...decision, shaAuthRef: event.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <button type="submit" className={PRIMARY_BUTTON_CLASS}>Record decision</button>
            </div>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}

interface ClaimLineDraft {
  shaServiceCode: string;
  description: string;
  amount: string;
  quantity: string;
  patientPay: boolean;
}

function previewCoverage(
  line: ClaimLineDraft,
  items: BenefitPackageItemRow[],
): { coverage: string; billed: string; patientCoPay: string; preauthRequired: boolean } {
  const item =
    items.find((candidate) => candidate.shaServiceCode && candidate.shaServiceCode === line.shaServiceCode) ?? null;
  const coverage = item?.coverage ?? (line.patientPay ? "excluded" : "unlisted");
  const amount = Number(line.amount || 0);
  const coPayPercent = item ? Number(item.coPayPercent) : 0;
  const coPay =
    coverage === "partial"
      ? Math.round(amount * coPayPercent) / 100
      : coverage === "excluded" || coverage === "unlisted"
        ? amount
        : 0;
  return {
    coverage,
    billed: (amount - coPay).toFixed(2),
    patientCoPay: coPay.toFixed(2),
    preauthRequired: Boolean(
      item?.requiresPreauth || (item?.preauthThreshold && amount > Number(item.preauthThreshold)),
    ),
  };
}

function RemittanceForm({ claim, capabilities, run }: { claim: ShaClaimDetail; capabilities: ShaCapabilities; run: RunCommand }) {
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ shaPaymentReportRef: "", bankReference: "", paymentDate: "" });

  useEffect(() => {
    setAllocations(
      Object.fromEntries(
        claim.lines.map((line) => [
          line.id,
          Number(line.approvedAmount) > 0 ? line.approvedAmount : line.amount,
        ]),
      ),
    );
  }, [claim.id, claim.lines]);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          "recordShaRemittance",
          {
            claimId: claim.id,
            allocations: Object.entries(allocations)
              .map(([claimLineId, amount]) => ({ claimLineId, amount }))
              .filter((item) => Number(item.amount) > 0),
            shaPaymentReportRef: form.shaPaymentReportRef || null,
            bankReference: form.bankReference || null,
            paymentDate: form.paymentDate || null,
            idempotencyKey: newKey(),
          },
          "SHA remittance recorded and posted to the ledger",
        );
      }}
    >
      <p className="text-xs text-muted-foreground">
        Allocate cash against approved claim lines. The approver and submitter cannot record the payment.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className={TABLE_CLASS}>
          <caption className="sr-only">Remittance allocations</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>Line</th>
              <th scope="col" className={TH_CLASS}>Approved</th>
              <th scope="col" className={TH_CLASS}>Amount received</th>
            </tr>
          </thead>
          <tbody>
            {claim.lines.map((line) => (
              <tr key={line.id}>
                <td className={TD_CLASS}>{line.description}</td>
                <td className={`${TD_CLASS} text-right`}>{formatMoney(line.approvedAmount)}</td>
                <td className={TD_CLASS}>
                  <input
                    aria-label={`Amount received for ${line.description}`}
                    className={`${INPUT_CLASS} h-8 w-32 text-right`}
                    inputMode="decimal"
                    value={allocations[line.id] ?? ""}
                    onChange={(event) =>
                      setAllocations((current) => ({ ...current, [line.id]: event.target.value }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="SHA payment report">
          <input
            className={INPUT_CLASS}
            value={form.shaPaymentReportRef}
            onChange={(event) => setForm({ ...form, shaPaymentReportRef: event.target.value })}
          />
        </Field>
        <Field label="Bank reference">
          <input
            className={INPUT_CLASS}
            value={form.bankReference}
            onChange={(event) => setForm({ ...form, bankReference: event.target.value })}
          />
        </Field>
        <Field label="Payment date">
          <input
            type="date"
            className={INPUT_CLASS}
            value={form.paymentDate}
            onChange={(event) => setForm({ ...form, paymentDate: event.target.value })}
          />
        </Field>
      </div>
      <button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={!capabilities.canFinance}>
        Record remittance
      </button>
    </form>
  );
}

function ClaimsPanel(props: PanelProps) {
  const { data, capabilities, run, selectedClaimId, selectClaim, setDocument } = props;
  const [form, setForm] = useState({
    patientId: "",
    payerId: "",
    encounterId: "",
    empanelmentId: "",
    benefitPackageId: "",
    fund: "shif",
    preAuthId: "",
    notes: "",
  });
  const [lines, setLines] = useState<ClaimLineDraft[]>([
    { shaServiceCode: "", description: "", amount: "", quantity: "1", patientPay: false },
  ]);
  const [createdCoverage, setCreatedCoverage] = useState<Array<{
    description: string;
    shaServiceCode: string | null;
    coverage: string;
    billed: string;
    patientCoPay: string;
    preauthRequired: boolean;
  }> | null>(null);
  const [adjudication, setAdjudication] = useState({ code: "", approvedAmount: "", note: "" });
  const [denial, setDenial] = useState({ code: "", reason: "" });

  const packageItems = data.benefitPackages.find((row) => row.id === form.benefitPackageId)?.items ?? [];
  const encounters = data.encounters.filter((row) => row.patientId === form.patientId);
  const selectedEncounter = data.encounters.find((row) => row.id === form.encounterId);
  const previews = lines.map((line) => previewCoverage(line, packageItems));
  const previewTotal = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const previewBilled = previews.reduce((sum, line) => sum + Number(line.billed), 0);
  const previewCoPay = previews.reduce((sum, line) => sum + Number(line.patientCoPay), 0);
  const claim = data.claimDetail;
  const adjudicationCodes = data.adjudicationCodes;

  const updateLine = (index: number, patch: Partial<ClaimLineDraft>) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  return (
    <div className="space-y-4">
      <Panel title="SHA claims" description="Drafts, submissions and adjudicated claims for this facility." testId="sha-claim-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA claims</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Claim</th>
                <th scope="col" className={TH_CLASS}>Patient</th>
                <th scope="col" className={TH_CLASS}>Fund</th>
                <th scope="col" className={TH_CLASS}>Billed</th>
                <th scope="col" className={TH_CLASS}>Paid</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.claims.length === 0 ? (
                <EmptyRow colSpan={7} message="No SHA claims have been built." />
              ) : (
                data.claims.map((row) => (
                  <tr key={row.id} className={selectedClaimId === row.id ? "bg-muted/50" : undefined}>
                    <td className={TD_CLASS}>
                      <span className="font-mono text-xs">{row.claimNo}</span>
                      <span className="block text-[10px] text-muted-foreground">{row.shaClaimRef ?? "no SHA ref"}</span>
                    </td>
                    <td className={TD_CLASS}>{row.patientName}</td>
                    <td className={TD_CLASS}>{row.fund?.toUpperCase() ?? "—"}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.billedAmount)}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.paidAmount)}</td>
                    <td className={TD_CLASS}><Pill value={row.status} /></td>
                    <td className={TD_CLASS}>
                      <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => selectClaim(row.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {capabilities.canClaim ? (
        <Panel
          title="Build SHA claim"
          description="Coverage is calculated from the selected tariff before the claim is submitted."
          testId="sha-claim-builder"
        >
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await run<{
                claimId: string;
                claimNo: string;
                coverage: typeof createdCoverage;
              }>(
                "createShaClaim",
                {
                  payerId: form.payerId,
                  patientId: form.patientId,
                  encounterId: form.encounterId,
                  invoiceId: selectedEncounter?.invoiceId,
                  empanelmentId: form.empanelmentId,
                  benefitPackageId: form.benefitPackageId,
                  fund: form.fund,
                  preAuthId: form.preAuthId || null,
                  notes: form.notes || null,
                  lines: lines.map((line) => ({
                    shaServiceCode: line.shaServiceCode || null,
                    description: line.description,
                    amount: line.amount,
                    quantity: Number(line.quantity),
                    patientPay: line.patientPay,
                  })),
                  idempotencyKey: newKey(),
                },
                "SHA claim draft created",
              );
              if (result) {
                setCreatedCoverage(result.coverage ?? null);
                selectClaim(result.claimId);
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Patient">
                <select
                  className={INPUT_CLASS}
                  value={form.patientId}
                  onChange={(event) => setForm({ ...form, patientId: event.target.value, encounterId: "" })}
                  required
                >
                  <option value="">Select patient</option>
                  {data.patients.map((patient) => (
                    <option key={patient.id} value={patient.id}>
                      {patient.mrn} · {patient.firstName} {patient.lastName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Encounter / invoice">
                <select
                  className={INPUT_CLASS}
                  value={form.encounterId}
                  onChange={(event) => setForm({ ...form, encounterId: event.target.value })}
                  required
                >
                  <option value="">Select encounter</option>
                  {encounters.filter((row) => row.invoiceId).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.encounterNo} · {row.invoiceNo} · {formatMoney(row.invoiceTotal ?? "0")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Payer">
                <select
                  className={INPUT_CLASS}
                  value={form.payerId}
                  onChange={(event) => setForm({ ...form, payerId: event.target.value })}
                  required
                >
                  <option value="">Select payer</option>
                  {data.payers.map((payer) => (
                    <option key={payer.id} value={payer.id}>{payer.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Fund">
                <select
                  className={INPUT_CLASS}
                  value={form.fund}
                  onChange={(event) => setForm({ ...form, fund: event.target.value, benefitPackageId: "", empanelmentId: "" })}
                >
                  {["phf", "shif", "eccif"].map((fund) => (
                    <option key={fund} value={fund}>{fund.toUpperCase()}</option>
                  ))}
                </select>
              </Field>
              <Field label="Empanelment">
                <select
                  className={INPUT_CLASS}
                  value={form.empanelmentId}
                  onChange={(event) => setForm({ ...form, empanelmentId: event.target.value })}
                  required
                >
                  <option value="">Select empanelment</option>
                  {data.empanelments.filter((row) => row.fund === form.fund).map((row) => (
                    <option key={row.id} value={row.id}>{row.schemeCode} · {row.contractNo ?? "no contract"}</option>
                  ))}
                </select>
              </Field>
              <Field label="Benefit package">
                <select
                  className={INPUT_CLASS}
                  value={form.benefitPackageId}
                  onChange={(event) => setForm({ ...form, benefitPackageId: event.target.value })}
                  required
                >
                  <option value="">Select package</option>
                  {data.benefitPackages.filter((row) => row.fund === form.fund).map((row) => (
                    <option key={row.id} value={row.id}>{row.packageCode} · {row.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Pre-authorisation">
                <select
                  className={INPUT_CLASS}
                  value={form.preAuthId}
                  onChange={(event) => setForm({ ...form, preAuthId: event.target.value })}
                >
                  <option value="">None</option>
                  {data.preAuthorizations.filter((row) => row.status === "approved" && row.patientId === form.patientId).map((row) => (
                    <option key={row.id} value={row.id}>{row.shaAuthRef ?? row.authNo}</option>
                  ))}
                </select>
              </Field>
              <Field label="Notes">
                <input
                  className={INPUT_CLASS}
                  value={form.notes}
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                />
              </Field>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">Claim lines and coverage preview</h4>
                  <p className="text-xs text-muted-foreground">
                    Excluded or unlisted codes require the patient-pay flag; they are never billed to SHA.
                  </p>
                </div>
                <button
                  type="button"
                  className={SMALL_BUTTON_CLASS}
                  onClick={() =>
                    setLines((current) => [
                      ...current,
                      { shaServiceCode: "", description: "", amount: "", quantity: "1", patientPay: false },
                    ])
                  }
                >
                  Add line
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className={TABLE_CLASS}>
                  <caption className="sr-only">Claim line coverage preview</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH_CLASS}>SHA code</th>
                      <th scope="col" className={TH_CLASS}>Description</th>
                      <th scope="col" className={TH_CLASS}>Amount</th>
                      <th scope="col" className={TH_CLASS}>Qty</th>
                      <th scope="col" className={TH_CLASS}>Patient pay</th>
                      <th scope="col" className={TH_CLASS}>Coverage</th>
                      <th scope="col" className={TH_CLASS}>SHA billed</th>
                      <th scope="col" className={TH_CLASS}>Co-pay</th>
                      <th scope="col" className={TH_CLASS}>Pre-auth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const preview = previews[index];
                      return (
                        <tr key={index}>
                          <td className={TD_CLASS}>
                            <select
                              aria-label={`SHA code for line ${index + 1}`}
                              className={`${INPUT_CLASS} h-8 w-36 px-2 text-xs`}
                              value={line.shaServiceCode}
                              onChange={(event) => {
                                const item = packageItems.find((candidate) => candidate.shaServiceCode === event.target.value);
                                updateLine(index, {
                                  shaServiceCode: event.target.value,
                                  description: item?.description ?? line.description,
                                  amount: item ? item.unitPrice : line.amount,
                                });
                              }}
                              required
                            >
                              <option value="">Select code</option>
                              {packageItems.map((item) => (
                                <option key={item.id} value={item.shaServiceCode ?? ""}>
                                  {item.shaServiceCode} · {item.description}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className={TD_CLASS}>
                            <input
                              aria-label={`Description for line ${index + 1}`}
                              className={`${INPUT_CLASS} h-8 w-48 px-2 text-xs`}
                              value={line.description}
                              onChange={(event) => updateLine(index, { description: event.target.value })}
                              required
                            />
                          </td>
                          <td className={TD_CLASS}>
                            <input
                              aria-label={`Amount for line ${index + 1}`}
                              className={`${INPUT_CLASS} h-8 w-24 px-2 text-right text-xs`}
                              inputMode="decimal"
                              value={line.amount}
                              onChange={(event) => updateLine(index, { amount: event.target.value })}
                              required
                            />
                          </td>
                          <td className={TD_CLASS}>
                            <input
                              aria-label={`Quantity for line ${index + 1}`}
                              className={`${INPUT_CLASS} h-8 w-16 px-2 text-right text-xs`}
                              inputMode="decimal"
                              value={line.quantity}
                              onChange={(event) => updateLine(index, { quantity: event.target.value })}
                            />
                          </td>
                          <td className={TD_CLASS}>
                            <input
                              type="checkbox"
                              aria-label={`Patient pay for line ${index + 1}`}
                              checked={line.patientPay}
                              onChange={(event) => updateLine(index, { patientPay: event.target.checked })}
                            />
                          </td>
                          <td className={TD_CLASS}><Pill value={preview.coverage} /></td>
                          <td className={`${TD_CLASS} text-right`}>{formatMoney(preview.billed)}</td>
                          <td className={`${TD_CLASS} text-right`}>{formatMoney(preview.patientCoPay)}</td>
                          <td className={TD_CLASS}>{preview.preauthRequired ? "Required" : "No"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span>
                  Preview total <span className="font-mono font-semibold">{formatMoney(previewTotal.toFixed(2))}</span>
                </span>
                <span>
                  SHA <span className="font-mono font-semibold">{formatMoney(previewBilled.toFixed(2))}</span>
                </span>
                <span>
                  Patient co-pay <span className="font-mono font-semibold">{formatMoney(previewCoPay.toFixed(2))}</span>
                </span>
              </div>
              {lines.length > 1 ? (
                <button
                  type="button"
                  className={SMALL_BUTTON_CLASS}
                  onClick={() => setLines((current) => current.slice(0, -1))}
                >
                  Remove last line
                </button>
              ) : null}
            </div>

            <button type="submit" className={PRIMARY_BUTTON_CLASS}>Create claim draft</button>
          </form>

          {createdCoverage ? (
            <div className="mt-4 rounded-lg border border-[var(--brand-mint)] bg-secondary/40 p-3" data-testid="sha-claim-coverage-result">
              <SubHeading title="Coverage applied at claim creation" description="Review before a second user submits the claim." />
              <div className="mt-3 overflow-x-auto">
                <table className={TABLE_CLASS}>
                  <caption className="sr-only">Created claim coverage</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH_CLASS}>Line</th>
                      <th scope="col" className={TH_CLASS}>Coverage</th>
                      <th scope="col" className={TH_CLASS}>SHA billed</th>
                      <th scope="col" className={TH_CLASS}>Co-pay</th>
                      <th scope="col" className={TH_CLASS}>Pre-auth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {createdCoverage.map((line, index) => (
                      <tr key={`${line.description}-${index}`}>
                        <td className={TD_CLASS}>{line.description}</td>
                        <td className={TD_CLASS}><Pill value={line.coverage} /></td>
                        <td className={`${TD_CLASS} text-right`}>{formatMoney(line.billed)}</td>
                        <td className={`${TD_CLASS} text-right`}>{formatMoney(line.patientCoPay)}</td>
                        <td className={TD_CLASS}>{line.preauthRequired ? "Required" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {claim ? (
        <Panel
          title={`Claim ${claim.claimNo}`}
          description={`${claim.patientName} · ${claim.encounterNo} · ${claim.status}`}
          action={
            <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => setDocument("claim")}>
              <Printer className="size-3.5" aria-hidden="true" />
              Print claim
            </button>
          }
          testId="sha-claim-detail"
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="SHA reference"><input className={INPUT_CLASS} value={claim.shaClaimRef ?? "Pending"} readOnly /></Field>
            <Field label="Billed"><input className={INPUT_CLASS} value={formatMoney(claim.billedAmount)} readOnly /></Field>
            <Field label="Approved"><input className={INPUT_CLASS} value={formatMoney(claim.approvedAmount)} readOnly /></Field>
            <Field label="Outstanding"><input className={INPUT_CLASS} value={formatMoney(claim.outstanding)} readOnly /></Field>
          </div>

          <div className="mt-4 space-y-3">
            <SubHeading title="Actions" description="Each transition is audited and separated by actor." />
            <div className="grid gap-4 lg:grid-cols-3">
              {capabilities.canClaim && claim.status === "draft" ? (
                <form
                  className="space-y-2 rounded-lg border border-border p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(
                      "submitShaClaim",
                      { claimId: claim.id, idempotencyKey: newKey() },
                      "SHA claim submitted",
                    );
                  }}
                >
                  <h4 className="text-sm font-semibold">Submit claim</h4>
                  <p className="text-xs text-muted-foreground">A different user from the preparer must submit.</p>
                  <button type="submit" className={BUTTON_CLASS}>Submit claim</button>
                </form>
              ) : null}

              {capabilities.canApprove && ["submitted", "resubmitted"].includes(claim.status) ? (
                <form
                  className="space-y-2 rounded-lg border border-border p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(
                      "recordShaAdjudication",
                      {
                        claimId: claim.id,
                        code: adjudication.code,
                        approvedAmount: adjudication.approvedAmount || null,
                        note: adjudication.note || null,
                        idempotencyKey: newKey(),
                      },
                      "Adjudication recorded",
                    );
                  }}
                >
                  <h4 className="text-sm font-semibold">Record adjudication</h4>
                  <Field label="Response code">
                    <select
                      className={INPUT_CLASS}
                      value={adjudication.code}
                      onChange={(event) => setAdjudication({ ...adjudication, code: event.target.value })}
                      required
                    >
                      <option value="">Select code</option>
                      {adjudicationCodes.filter((code) => code.category !== "rejected").map((code) => (
                        <option key={code.id} value={code.code}>{code.code} · {code.description}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Approved amount">
                    <input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      value={adjudication.approvedAmount}
                      onChange={(event) => setAdjudication({ ...adjudication, approvedAmount: event.target.value })}
                    />
                  </Field>
                  <button type="submit" className={BUTTON_CLASS}>Record adjudication</button>
                </form>
              ) : null}

              {capabilities.canClaim && ["submitted", "resubmitted", "queried"].includes(claim.status) ? (
                <form
                  className="space-y-2 rounded-lg border border-border p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(
                      "recordShaDenial",
                      { claimId: claim.id, code: denial.code, reason: denial.reason, idempotencyKey: newKey() },
                      "SHA denial recorded",
                    );
                  }}
                >
                  <h4 className="text-sm font-semibold">Record denial</h4>
                  <Field label="Rejection code">
                    <select
                      className={INPUT_CLASS}
                      value={denial.code}
                      onChange={(event) => setDenial({ ...denial, code: event.target.value })}
                      required
                    >
                      <option value="">Select code</option>
                      {adjudicationCodes.filter((code) => code.category === "rejected").map((code) => (
                        <option key={code.id} value={code.code}>{code.code} · {code.description}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Reason">
                    <input
                      className={INPUT_CLASS}
                      value={denial.reason}
                      onChange={(event) => setDenial({ ...denial, reason: event.target.value })}
                      required
                    />
                  </Field>
                  <button type="submit" className={BUTTON_CLASS}>Record denial</button>
                </form>
              ) : null}
            </div>
            {["accepted", "paid"].includes(claim.status) ? (
              <div className="rounded-lg border border-border p-3">
                <SubHeading title="Record remittance" description="Cash receipt posts a balanced bank / receivable journal." />
                <div className="mt-3">
                  <RemittanceForm claim={claim} capabilities={capabilities} run={run} />
                </div>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : (
        <Panel title="Claim detail" description="Select a claim to see lines, actions and print documents." testId="sha-claim-detail-empty">
          <p className="text-sm text-muted-foreground">No claim selected.</p>
        </Panel>
      )}
    </div>
  );
}

function RemittancesPanel({ data, selectedClaimId, selectClaim, setDocument }: PanelProps) {
  const claim = data.claimDetail;
  return (
    <div className="space-y-4">
      <Panel title="SHA remittances" description="Immutable cash receipts against accepted claims." testId="sha-remittance-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA remittances</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Receipt</th>
                <th scope="col" className={TH_CLASS}>Claim</th>
                <th scope="col" className={TH_CLASS}>Patient</th>
                <th scope="col" className={TH_CLASS}>SHA report</th>
                <th scope="col" className={TH_CLASS}>Received</th>
                <th scope="col" className={TH_CLASS}>Amount</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.remittances.length === 0 ? (
                <EmptyRow colSpan={7} message="No SHA remittances recorded." />
              ) : (
                data.remittances.map((row) => (
                  <tr key={row.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.remittanceNo}</td>
                    <td className={TD_CLASS}>{row.claimNo}</td>
                    <td className={TD_CLASS}>{row.patientName}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.shaPaymentReportRef ?? "—"}</td>
                    <td className={`${TD_CLASS} text-xs`}>{formatDate(row.paymentDate ?? row.receivedAt)}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.amount)}</td>
                    <td className={TD_CLASS}>
                      <button
                        type="button"
                        className={SMALL_BUTTON_CLASS}
                        onClick={() => {
                          selectClaim(row.claimId);
                          setDocument("remittance");
                        }}
                      >
                        Advice
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      {claim ? (
        <Panel
          title={`Remittance advice · ${claim.claimNo}`}
          description={`${claim.remittances.length} receipt(s) · ${formatMoney(claim.paidAmount)} paid`}
          testId="sha-remittance-detail"
          action={
            <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => setDocument("remittance")}>
              <Printer className="size-3.5" aria-hidden="true" />
              Print advice
            </button>
          }
        >
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <caption className="sr-only">Remittance allocations for selected claim</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Receipt</th>
                  <th scope="col" className={TH_CLASS}>Line</th>
                  <th scope="col" className={TH_CLASS}>Bank reference</th>
                  <th scope="col" className={TH_CLASS}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {claim.remittances.length === 0 ? (
                  <EmptyRow colSpan={4} message="This claim has no remittance." />
                ) : (
                  claim.remittances.map((row) => (
                    <tr key={row.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.remittanceNo}</td>
                      <td className={TD_CLASS}>
                        {claim.lines.find((line) => line.id === row.claimLineId)?.description ?? "Claim level"}
                      </td>
                      <td className={TD_CLASS}>{row.bankReference ?? row.reference ?? "—"}</td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(row.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        <Panel title="Remittance detail" description="Select a remittance to see the advice." testId="sha-remittance-detail-empty">
          <p className="text-sm text-muted-foreground">
            {selectedClaimId ? "Loading the selected claim…" : "No remittance selected."}
          </p>
        </Panel>
      )}
    </div>
  );
}

function ReconciliationPanel({ data, capabilities, run, selectedReconciliationId, selectReconciliation }: PanelProps) {
  const [form, setForm] = useState({
    kmpdcNumber: data.empanelments[0]?.kmpdcNumber ?? "",
    reportPeriod: monthStartIso().slice(0, 7),
    reportRef: "",
    shaReportedAmount: "",
    paymentDate: "",
  });
  const [lines, setLines] = useState([{ claimRef: "", shaAmount: "", reason: "" }]);
  const reconciliation = data.reconciliation;
  const lineTotal = lines.reduce((sum, line) => sum + Number(line.shaAmount || 0), 0);

  return (
    <div className="space-y-4">
      <Panel
        title="Payment reconciliation"
        description="SHA reported totals are compared with facility invoices, matched claims and variance."
        testId="sha-reconciliation-summary"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi testId="sha-recon-reported" label="SHA reported" value={formatMoney(reconciliation?.shaReportedAmount ?? "0")} helper={reconciliation?.reportRef ?? "No report loaded"} icon={<CircleDollarSign className="size-4" />} />
          <Kpi testId="sha-recon-invoiced" label="Facility invoiced" value={formatMoney(reconciliation?.facilityInvoicedAmount ?? "0")} helper="Matched claim value" icon={<FileText className="size-4" />} />
          <Kpi testId="sha-recon-matched" label="Matched" value={formatMoney(reconciliation?.matchedAmount ?? "0")} helper={`${reconciliation?.lines.filter((line) => line.status === "matched").length ?? 0} lines`} icon={<BadgeCheck className="size-4" />} />
          <Kpi
            testId="sha-recon-variance"
            label="Variance"
            value={formatMoney(reconciliation?.variance ?? "0")}
            helper={reconciliation?.status ?? "No report loaded"}
            icon={<AlertTriangle className="size-4" />}
            tone={Number(reconciliation?.variance ?? 0) !== 0 ? "danger" : "success"}
          />
        </div>
      </Panel>

      <Panel title="Reconciliation history" description="Select a report to inspect line-level matches and unmatched cash." testId="sha-reconciliation-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA reconciliation reports</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Report</th>
                <th scope="col" className={TH_CLASS}>Period</th>
                <th scope="col" className={TH_CLASS}>SHA total</th>
                <th scope="col" className={TH_CLASS}>Facility total</th>
                <th scope="col" className={TH_CLASS}>Variance</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.reconciliations.length === 0 ? (
                <EmptyRow colSpan={7} message="No payment reports reconciled." />
              ) : (
                data.reconciliations.map((row) => (
                  <tr key={row.id} className={selectedReconciliationId === row.id ? "bg-muted/50" : undefined}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.reportRef ?? "—"}</td>
                    <td className={TD_CLASS}>{row.reportPeriod}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.shaReportedAmount)}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.facilityInvoicedAmount)}</td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.variance)}</td>
                    <td className={TD_CLASS}><Pill value={row.status} /></td>
                    <td className={TD_CLASS}>
                      <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => selectReconciliation(row.id)}>Open</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {reconciliation ? (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <SubHeading
              title={`${reconciliation.kmpdcNumber} · ${reconciliation.reportPeriod}`}
              description={`Journal ${reconciliation.journalEntryNo ?? "not posted"} · generated ${formatDate(reconciliation.generatedAt)}`}
            />
            <div className="mt-3 overflow-x-auto">
              <table className={TABLE_CLASS}>
                <caption className="sr-only">Reconciliation lines</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH_CLASS}>Claim ref</th>
                    <th scope="col" className={TH_CLASS}>SHA amount</th>
                    <th scope="col" className={TH_CLASS}>Facility amount</th>
                    <th scope="col" className={TH_CLASS}>Variance</th>
                    <th scope="col" className={TH_CLASS}>Status</th>
                    <th scope="col" className={TH_CLASS}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.lines.map((line) => (
                    <tr key={line.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{line.claimNo ?? "—"}</td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(line.shaAmount)}</td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(line.facilityAmount)}</td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(line.variance)}</td>
                      <td className={TD_CLASS}><Pill value={line.status} /></td>
                      <td className={`${TD_CLASS} text-xs`}>{line.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Panel>

      {capabilities.canFinance ? (
        <Panel
          title="Import SHA payment report"
          description="Unmatched lines remain as variance; cash already posted by remittance is not double-counted."
          testId="sha-reconciliation-form"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "reconcileShaPaymentReport",
                {
                  ...form,
                  reportRef: form.reportRef || null,
                  paymentDate: form.paymentDate || null,
                  shaReportedAmount: form.shaReportedAmount || lineTotal.toFixed(2),
                  lines: lines.map((line) => ({
                    claimRef: line.claimRef,
                    shaAmount: line.shaAmount,
                    reason: line.reason || null,
                  })),
                  idempotencyKey: newKey(),
                },
                "SHA payment report reconciled",
              );
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="KMPDC number">
                <input
                  className={INPUT_CLASS}
                  value={form.kmpdcNumber}
                  onChange={(event) => setForm({ ...form, kmpdcNumber: event.target.value })}
                  required
                />
              </Field>
              <Field label="Report period">
                <input
                  type="month"
                  className={INPUT_CLASS}
                  value={form.reportPeriod}
                  onChange={(event) => setForm({ ...form, reportPeriod: event.target.value })}
                  required
                />
              </Field>
              <Field label="Report reference">
                <input
                  className={INPUT_CLASS}
                  value={form.reportRef}
                  onChange={(event) => setForm({ ...form, reportRef: event.target.value })}
                />
              </Field>
              <Field label="SHA reported amount" hint={`Line total: ${formatMoney(lineTotal.toFixed(2))}`}>
                <input
                  className={INPUT_CLASS}
                  inputMode="decimal"
                  value={form.shaReportedAmount}
                  onChange={(event) => setForm({ ...form, shaReportedAmount: event.target.value })}
                />
              </Field>
              <Field label="Payment date">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={form.paymentDate}
                  onChange={(event) => setForm({ ...form, paymentDate: event.target.value })}
                />
              </Field>
            </div>
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Report lines</h4>
                <button
                  type="button"
                  className={SMALL_BUTTON_CLASS}
                  onClick={() => setLines((current) => [...current, { claimRef: "", shaAmount: "", reason: "" }])}
                >
                  Add line
                </button>
              </div>
              {lines.map((line, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-3">
                  <input
                    aria-label={`Claim reference for report line ${index + 1}`}
                    className={INPUT_CLASS}
                    placeholder="SHA claim reference"
                    value={line.claimRef}
                    onChange={(event) =>
                      setLines((current) => current.map((item, i) => (i === index ? { ...item, claimRef: event.target.value } : item)))
                    }
                    required
                  />
                  <input
                    aria-label={`SHA amount for report line ${index + 1}`}
                    className={INPUT_CLASS}
                    inputMode="decimal"
                    placeholder="Amount"
                    value={line.shaAmount}
                    onChange={(event) =>
                      setLines((current) => current.map((item, i) => (i === index ? { ...item, shaAmount: event.target.value } : item)))
                    }
                    required
                  />
                  <input
                    aria-label={`Reason for report line ${index + 1}`}
                    className={INPUT_CLASS}
                    placeholder="Reason (optional)"
                    value={line.reason}
                    onChange={(event) =>
                      setLines((current) => current.map((item, i) => (i === index ? { ...item, reason: event.target.value } : item)))
                    }
                  />
                </div>
              ))}
            </div>
            <button type="submit" className={PRIMARY_BUTTON_CLASS}>Reconcile report</button>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}

function DenialsPanel({ data, capabilities, run, selectedClaimId, selectClaim }: PanelProps) {
  const claim = data.claimDetail;
  const [form, setForm] = useState({ note: "", adjustments: {} as Record<string, string> });
  const deniedClaims = data.claims.filter((row) => row.status === "rejected" || row.denialCount > 0);
  const selectedDenial = claim?.denials[0] ?? null;

  useEffect(() => {
    setForm({
      note: "",
      adjustments: Object.fromEntries((claim?.lines ?? []).map((line) => [line.id, line.amount])),
    });
  }, [claim?.id, claim?.lines]);

  return (
    <div className="space-y-4">
      <Panel title="SHA denials and rework" description="Every denial keeps its reason and rework action." testId="sha-denials-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <caption className="sr-only">SHA claim denials</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Claim</th>
                <th scope="col" className={TH_CLASS}>Code</th>
                <th scope="col" className={TH_CLASS}>Reason</th>
                <th scope="col" className={TH_CLASS}>Amount</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {deniedClaims.length === 0 ? (
                <EmptyRow colSpan={6} message="No denied SHA claims." />
              ) : (
                deniedClaims.map((row) => (
                  <tr key={row.id} className={selectedClaimId === row.id ? "bg-muted/50" : undefined}>
                    <td className={TD_CLASS}>
                      <span className="font-mono text-xs">{row.claimNo}</span>
                      <span className="block text-[10px] text-muted-foreground">{row.patientName}</span>
                    </td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{row.adjudicationCode ?? "—"}</td>
                    <td className={TD_CLASS}>
                      {selectedClaimId === row.id && selectedDenial ? selectedDenial.reason : `${row.denialCount} denial(s) recorded`}
                    </td>
                    <td className={`${TD_CLASS} text-right`}>{formatMoney(row.billedAmount)}</td>
                    <td className={TD_CLASS}><Pill value={row.status} /></td>
                    <td className={TD_CLASS}>
                      <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => selectClaim(row.id)}>
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {claim && selectedDenial ? (
        <Panel
          title={`Rework ${claim.claimNo}`}
          description={`Denial ${selectedDenial.code ?? "—"}: ${selectedDenial.reason}`}
          testId="sha-rework-form"
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "reworkShaClaim",
                {
                  claimId: claim.id,
                  denialId: selectedDenial.id,
                  note: form.note || null,
                  lineAdjustments: Object.entries(form.adjustments)
                    .map(([claimLineId, amount]) => ({ claimLineId, amount }))
                    .filter((item) => Number(item.amount) > 0),
                  idempotencyKey: newKey(),
                },
                "Rework claim created",
              );
            }}
          >
            <Field label="Rework note">
              <input
                className={INPUT_CLASS}
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                placeholder="Correction applied"
              />
            </Field>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className={TABLE_CLASS}>
                <caption className="sr-only">Reworked line amounts</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH_CLASS}>Line</th>
                    <th scope="col" className={TH_CLASS}>Original</th>
                    <th scope="col" className={TH_CLASS}>Reworked amount</th>
                  </tr>
                </thead>
                <tbody>
                  {claim.lines.map((line) => (
                    <tr key={line.id}>
                      <td className={TD_CLASS}>{line.description}</td>
                      <td className={`${TD_CLASS} text-right`}>{formatMoney(line.amount)}</td>
                      <td className={TD_CLASS}>
                        <input
                          aria-label={`Reworked amount for ${line.description}`}
                          className={`${INPUT_CLASS} h-8 w-28 text-right`}
                          inputMode="decimal"
                          value={form.adjustments[line.id] ?? line.amount}
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              adjustments: { ...current.adjustments, [line.id]: event.target.value },
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={!capabilities.canClaim}>
              Create rework claim
            </button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            The new draft keeps the SHA claim reference and links back through <code>supersedes_claim_id</code>.
          </p>
        </Panel>
      ) : (
        <Panel title="Rework detail" description="Select a denied claim to prepare a corrected draft." testId="sha-rework-empty">
          <p className="text-sm text-muted-foreground">No denial selected.</p>
        </Panel>
      )}
    </div>
  );
}

export function ShaWorkspace({
  capabilities,
}: {
  capabilities: ShaCapabilities;
}) {
  const [data, setData] = useState<ShaData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ShaTab>("empanelment");
  const [selectedClaimId, setSelectedClaimId] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [selectedReconciliationId, setSelectedReconciliationId] = useState("");
  const [patientQuery, setPatientQuery] = useState("");
  const [document, setDocument] = useState<"claim" | "remittance" | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedClaimId) params.set("claimId", selectedClaimId);
    if (selectedPatientId) params.set("patientId", selectedPatientId);
    if (selectedPackageId) params.set("packageId", selectedPackageId);
    if (selectedReconciliationId) params.set("reconciliationId", selectedReconciliationId);
    if (patientQuery) params.set("q", patientQuery);
    const response = await fetch(`/api/sha?${params.toString()}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load SHA data (${response.status})`);
    }
    setData((await response.json()) as ShaData);
  }, [patientQuery, selectedClaimId, selectedPackageId, selectedPatientId, selectedReconciliationId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load SHA data";
      setError(message);
      toast.error(message);
    }
  }, [load]);

  const run = useCallback<RunCommand>(
    async <T,>(command: string, input: Record<string, unknown>, success: string): Promise<T | null> => {
      try {
        setError(null);
        const result = await postShaCommand<T>(command, input);
        toast.success(success);
        await refresh();
        return result;
      } catch (commandError) {
        const message =
          commandError instanceof Error ? commandError.message : "The SHA command failed";
        setError(message);
        toast.error(message);
        return null;
      }
    },
    [refresh],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load SHA data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const selectClaim = useCallback((id: string) => {
    setSelectedClaimId(id);
    setDocument(null);
  }, []);

  const panelProps: PanelProps = useMemo(
    () => ({
      data,
      capabilities,
      run,
      refresh,
      selectedClaimId,
      selectClaim,
      selectedPatientId,
      selectPatient: setSelectedPatientId,
      selectedPackageId,
      selectPackage: setSelectedPackageId,
      selectedReconciliationId,
      selectReconciliation: setSelectedReconciliationId,
      patientQuery,
      setPatientQuery,
      setDocument,
    }),
    [
      capabilities,
      data,
      patientQuery,
      refresh,
      run,
      selectClaim,
      selectedClaimId,
      selectedPackageId,
      selectedPatientId,
      selectedReconciliationId,
    ],
  );

  const activeEmpanelments = data.empanelments.filter((row) => row.contractStatus === "active").length;
  const openClaims = data.claims.filter((row) => ["draft", "submitted", "accepted", "queried", "resubmitted"].includes(row.status));
  const openValue = openClaims.reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const pendingPreAuths = data.preAuthorizations.filter((row) => row.status === "requested").length;

  return (
    <div className="space-y-4" data-testid="sha-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          testId="sha-kpi-empanelments"
          label="Active empanelments"
          value={String(activeEmpanelments)}
          helper={`${data.benefitPackages.length} benefit packages`}
          icon={<ShieldCheck className="size-4" />}
          tone={activeEmpanelments > 0 ? "success" : undefined}
        />
        <Kpi
          testId="sha-kpi-open-claims"
          label="Open SHA claims"
          value={String(openClaims.length)}
          helper={formatMoney(openValue.toFixed(2))}
          icon={<FileClock className="size-4" />}
        />
        <Kpi
          testId="sha-kpi-preauth"
          label="Pending pre-auths"
          value={String(pendingPreAuths)}
          helper="Awaiting a decision"
          icon={<Users className="size-4" />}
        />
        <Kpi
          testId="sha-kpi-variance"
          label="Latest variance"
          value={formatMoney(data.reconciliation?.variance ?? "0")}
          helper={data.reconciliation?.reportRef ?? "No report loaded"}
          icon={<AlertTriangle className="size-4" />}
          tone={Number(data.reconciliation?.variance ?? 0) !== 0 ? "danger" : "success"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <button
          type="button"
          onClick={() => void refresh()}
          className={BUTTON_CLASS}
          data-testid="sha-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
        <p className="text-xs text-muted-foreground">
          Empanelment, tariffs, eligibility and SHA payment data are maintained in this workspace.
        </p>
      </div>

      <div role="tablist" aria-label="SHA revenue cycle sections" className="flex flex-wrap gap-1 border-b border-border">
        {SHA_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`sha-tab-${tab.id}`}
            aria-controls={`sha-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            data-testid={`sha-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              activeTab === tab.id
                ? "border-[var(--brand-mint)] text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error ? (
        <section
          role="alert"
          className="rounded-xl border border-[var(--status-critical)] bg-[var(--status-critical-background)] p-4 text-sm text-[var(--status-critical-foreground)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={() => void refresh()} className={SMALL_BUTTON_CLASS}>
              Try again
            </button>
          </div>
        </section>
      ) : null}

      {loading ? (
        <LoadingPanel label="Loading SHA revenue cycle" title="Loading empanelment, claims and reconciliation data" rows={5} />
      ) : (
        <div
          role="tabpanel"
          id={`sha-panel-${activeTab}`}
          aria-labelledby={`sha-tab-${activeTab}`}
          className="space-y-4"
        >
          {activeTab === "empanelment" ? <EmpanelmentPanel {...panelProps} /> : null}
          {activeTab === "eligibility" ? <EligibilityPanel {...panelProps} /> : null}
          {activeTab === "preauth" ? <PreAuthorizationPanel {...panelProps} /> : null}
          {activeTab === "claims" ? <ClaimsPanel {...panelProps} /> : null}
          {activeTab === "remittances" ? <RemittancesPanel {...panelProps} /> : null}
          {activeTab === "reconciliation" ? <ReconciliationPanel {...panelProps} /> : null}
          {activeTab === "denials" ? <DenialsPanel {...panelProps} /> : null}
        </div>
      )}

      {document && data.claimDetail ? (
        <div className="sha-print-region">
          {document === "claim" ? <ShaClaimDocument claim={data.claimDetail} /> : null}
          {document === "remittance" ? <ShaRemittanceDocument claim={data.claimDetail} /> : null}
          <button
            type="button"
            className={`${SMALL_BUTTON_CLASS} sha-hide-print mt-3`}
            onClick={() => setDocument(null)}
          >
            Close document
          </button>
        </div>
      ) : null}
    </div>
  );
}
