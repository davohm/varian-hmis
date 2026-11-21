"use client";

import {
  CheckCheck,
  FileWarning,
  Fingerprint,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  formatDate,
  formatMoney,
  postTaxCommand,
  queueStatusLabel,
  queueStatusTone,
  taxTreatmentLabel,
  type EtimsStatusResponse,
  type EtimsTransactionDetail,
  type EtimsTransactionRow,
  type TaxResponse,
} from "@/components/finance/tax-types";
import { Button } from "@/components/ui/button";
import { LoadingPanel } from "@/components/ui/loading-panel";
import { ETIMS_QUEUE_STATUSES, TAX_TREATMENTS } from "@/lib/tax";

const PRINT_STYLES = `
  @media screen { .tax-print-sheet { display: none; } }
  @media print {
    body * { visibility: hidden !important; }
    .tax-print-sheet, .tax-print-sheet * { visibility: visible !important; }
    .tax-print-sheet {
      display: block !important;
      position: absolute !important;
      inset: 0 !important;
      margin: 0 !important;
      padding: 16mm !important;
      background: white !important;
      color: black !important;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
    }
    .tax-print-sheet img { max-width: 42mm !important; image-rendering: pixelated; }
  }
`;

interface Filters {
  status: string;
  documentType: string;
  environment: string;
  from: string;
  to: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  status: "",
  documentType: "",
  environment: "",
  from: "",
  to: "",
  search: "",
};

function Kpi({
  label,
  value,
  hint,
  icon,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--status-info-background)] text-[var(--status-info-foreground)]"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-mono text-base font-semibold tabular-nums text-foreground">{value}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Meta({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs text-foreground" title={value}>
        {value || "—"}
      </dd>
    </div>
  );
}

export function TaxWorkspace({ canWrite }: { canWrite: boolean }) {
  const [response, setResponse] = useState<TaxResponse | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState("");
  const [statusDetail, setStatusDetail] = useState<EtimsStatusResponse["status"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [invoiceId, setInvoiceId] = useState("");
  const [buyerPin, setBuyerPin] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");

  const [taxCodeDraft, setTaxCodeDraft] = useState({
    code: "",
    name: "",
    rate: "16",
    treatment: "vat_standard",
    effectiveFrom: new Date().toISOString().slice(0, 10),
  });

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
    }
    if (selectedId) params.set("queueId", selectedId);

    const result = await fetch(`/api/finance/tax?${params.toString()}`, { cache: "no-store" });
    if (result.status === 401 || result.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!result.ok) {
      const body = (await result.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load KRA transactions (${result.status})`);
    }
    const body = (await result.json()) as TaxResponse;
    if (isCurrent()) setResponse(body);
  }, [filters, selectedId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load KRA transactions";
      setError(message);
      toast.error(message);
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load(() => !cancelled)
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load KRA transactions");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!selectedId && response && response.transactions.length > 0) {
      const first = response.transactions[0];
      setSelectedId(first.queueId);
      setEnvironment(first.environment);
    }
  }, [response, selectedId]);

  useEffect(() => {
    if (!invoiceId && response && response.invoices.length > 0) {
      setInvoiceId(response.invoices[0].id);
    }
  }, [response, invoiceId]);

  const refreshStatus = useCallback(async () => {
    if (!selectedId) return;
    const result = await fetch(
      `/api/finance/tax?view=status&queueId=${encodeURIComponent(selectedId)}`,
      { cache: "no-store" },
    );
    if (!result.ok) return;
    const body = (await result.json()) as EtimsStatusResponse;
    setStatusDetail(body.status);
  }, [selectedId]);

  useEffect(() => {
    setStatusDetail(null);
    void refreshStatus().catch(() => null);
  }, [refreshStatus]);

  const detail: EtimsTransactionDetail | null = response?.detail ?? null;
  const activeTransaction: EtimsTransactionRow | null =
    detail ?? response?.transactions.find((row) => row.queueId === selectedId) ?? null;

  async function run(command: string, input: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await postTaxCommand(command, input);
      toast.success(message);
      await refresh();
      await refreshStatus().catch(() => null);
      return true;
    } catch (commandError) {
      const text =
        commandError instanceof Error ? commandError.message : "The command could not be completed";
      setError(text);
      toast.error(text);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function updateFilter(key: keyof Filters, value: string) {
    // A selected queue row is only meaningful for the current result set.
    // Keeping it while filters change would add a stale queueId to the next
    // request and hide newly matching documents.
    setSelectedId("");
    setStatusDetail(null);
    // Keep the invoice picker, but drop rows/detail from the previous filter
    // so a stale response cannot re-select a document outside the new result.
    setResponse((current) =>
      current ? { ...current, transactions: [], detail: null } : current,
    );
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function saveTaxCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      "upsertTaxCode",
      {
        code: taxCodeDraft.code,
        name: taxCodeDraft.name,
        rate: taxCodeDraft.rate,
        treatment: taxCodeDraft.treatment,
        effectiveFrom: taxCodeDraft.effectiveFrom,
      },
      "Tax code saved",
    );
    setTaxCodeDraft((current) => ({ ...current, code: "", name: "" }));
  }

  function printInvoice() {
    if (!detail) {
      toast.error("Select an acknowledged transaction to print");
      return;
    }
    window.print();
  }

  const sandbox = response?.integrations.find((row) => row.environment === "sandbox");
  const production = response?.integrations.find((row) => row.environment === "production");

  return (
    <div className="flex flex-col gap-4" data-testid="tax-workspace">
      <style>{PRINT_STYLES}</style>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="eTIMS summary">
        <Kpi
          label="Acknowledged"
          value={String(response?.summary.acknowledged ?? 0)}
          hint="KRA control number issued"
          icon={<CheckCheck className="size-4" aria-hidden />}
          testId="tax-kpi-acknowledged"
        />
        <Kpi
          label="Pending"
          value={String(response?.summary.pending ?? 0)}
          hint="Queued for transmission"
          icon={<Fingerprint className="size-4" aria-hidden />}
          testId="tax-kpi-pending"
        />
        <Kpi
          label="Needs attention"
          value={String(response?.summary.failed ?? 0)}
          hint="Failed or rejected documents"
          icon={<FileWarning className="size-4" aria-hidden />}
          testId="tax-kpi-failed"
        />
        <Kpi
          label="Environment"
          value={environment === "sandbox" ? "SANDBOX" : "PRODUCTION"}
          hint={sandbox?.enabled ? "Sandbox adapter enabled" : "Check integration settings"}
          icon={<ShieldCheck className="size-4" aria-hidden />}
          testId="tax-kpi-environment"
        />
      </section>

      <Panel
        title="KRA transactions"
        description="Finalised invoices and credit notes with their durable transmission state."
        testId="tax-transactions-panel"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            data-testid="tax-refresh"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        }
      >
        <div className="mb-4 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Status">
            <select
              className={INPUT_CLASS}
              value={filters.status}
              onChange={(event) => updateFilter("status", event.target.value)}
              data-testid="tax-filter-status"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {ETIMS_QUEUE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {queueStatusLabel(status)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Document">
            <select
              className={INPUT_CLASS}
              value={filters.documentType}
              onChange={(event) => updateFilter("documentType", event.target.value)}
              data-testid="tax-filter-document"
              aria-label="Filter by document type"
            >
              <option value="">All documents</option>
              <option value="invoice">Invoice</option>
              <option value="credit_note">Credit note</option>
            </select>
          </Field>
          <Field label="Environment">
            <select
              className={INPUT_CLASS}
              value={filters.environment}
              onChange={(event) => updateFilter("environment", event.target.value)}
              data-testid="tax-filter-environment"
              aria-label="Filter by environment"
            >
              <option value="">Both</option>
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </Field>
          <Field label="From">
            <input
              type="date"
              className={INPUT_CLASS}
              value={filters.from}
              onChange={(event) => updateFilter("from", event.target.value)}
              data-testid="tax-filter-from"
              aria-label="Transactions from date"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={INPUT_CLASS}
              value={filters.to}
              onChange={(event) => updateFilter("to", event.target.value)}
              data-testid="tax-filter-to"
              aria-label="Transactions to date"
            />
          </Field>
          <Field label="Search">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                className={`${INPUT_CLASS} pl-8`}
                value={filters.search}
                onChange={(event) => updateFilter("search", event.target.value)}
                placeholder="Invoice, patient, buyer"
                data-testid="tax-filter-search"
                aria-label="Search KRA transactions"
              />
            </div>
          </Field>
        </div>

        {loading ? (
          <LoadingPanel label="Loading KRA transactions" />
        ) : error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS} data-testid="tax-transactions-table">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Trans no</th>
                  <th className={TH_CLASS}>Invoice no</th>
                  <th className={TH_CLASS}>Company</th>
                  <th className={TH_CLASS}>Date</th>
                  <th className={TH_CLASS}>Patient</th>
                  <th className={`${TH_CLASS} text-right`}>Amount</th>
                  <th className={TH_CLASS}>Status</th>
                </tr>
              </thead>
              <tbody>
                {response?.transactions.length ? (
                  response.transactions.map((row) => (
                    <tr
                      key={row.queueId}
                      data-testid={`tax-row-${row.queueId}`}
                      onClick={() => setSelectedId(row.queueId)}
                      className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                        selectedId === row.queueId ? "bg-muted/70" : ""
                      }`}
                    >
                      <td className={`${TD_CLASS} font-mono text-xs`}>{row.transNo}</td>
                      <td className={`${TD_CLASS} font-mono text-xs font-medium`}>{row.invoiceNo}</td>
                      <td className={TD_CLASS}>{row.company}</td>
                      <td className={TD_CLASS}>{formatDate(row.date)}</td>
                      <td className={TD_CLASS}>{row.patient}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {formatMoney(row.amount)}
                      </td>
                      <td className={TD_CLASS}>
                        <StatusPill tone={queueStatusTone(row.status)}>
                          {queueStatusLabel(row.status)}
                        </StatusPill>
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={7} message="No eTIMS documents match these filters." />
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-5">
        <Panel
          title="KRA document"
          description="Signature, QR and transmission evidence for the selected transaction."
          testId="tax-detail-panel"
          className="xl:col-span-3"
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshStatus().catch(() => null)}
                data-testid="tax-refresh-status"
                disabled={!selectedId || busy}
              >
                <RefreshCw className="size-3.5" aria-hidden /> Status
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void run(
                    "retryEtimsInvoice",
                    { queueId: selectedId, environment: activeTransaction?.environment ?? environment },
                    "Retry queued",
                  )
                }
                data-testid="tax-retry"
                disabled={!canWrite || !selectedId || activeTransaction?.status !== "failed" || busy}
              >
                <RotateCcw className="size-3.5" aria-hidden /> Retry
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={printInvoice}
                data-testid="tax-print"
                disabled={!detail}
              >
                <Printer className="size-3.5" aria-hidden /> Print
              </Button>
            </div>
          }
        >
          {!activeTransaction ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select a transaction to inspect its KRA acknowledgement.
            </p>
          ) : (
            <div className="flex flex-col gap-4 md:flex-row">
              <div className="min-w-0 flex-1">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  <Meta label="Transaction" value={activeTransaction.transNo} />
                  <Meta label="Invoice" value={activeTransaction.invoiceNo} />
                  <Meta label="Document" value={activeTransaction.documentType.replace("_", " ")} />
                  <Meta label="Control number" value={activeTransaction.kraControlNo ?? ""} testId="tax-control-number" />
                  <Meta label="CU number" value={activeTransaction.cuNo ?? ""} />
                  <Meta label="Attempts" value={String(activeTransaction.attempts)} />
                  <Meta label="Status" value={queueStatusLabel(activeTransaction.status)} />
                  <Meta label="Environment" value={activeTransaction.environment} />
                  <Meta label="Amount" value={formatMoney(activeTransaction.amount)} />
                </dl>

                <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    KRA signature
                  </p>
                  <p
                    className="mt-1 wrap-anywhere font-mono text-[11px] leading-relaxed text-foreground"
                    data-testid="tax-signature"
                  >
                    {activeTransaction.kraSignature ?? "Not yet issued"}
                  </p>
                  {activeTransaction.lastError ? (
                    <p className="mt-2 text-xs text-destructive">{activeTransaction.lastError}</p>
                  ) : null}
                </div>

                {statusDetail?.logs.length ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className={TABLE_CLASS}>
                      <thead>
                        <tr>
                          <th className={TH_CLASS}>Attempt</th>
                          <th className={TH_CLASS}>Outcome</th>
                          <th className={TH_CLASS}>HTTP</th>
                          <th className={TH_CLASS}>Code</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusDetail.logs.map((log) => (
                          <tr key={`${log.attempt}-${log.createdAt}`}>
                            <td className={TD_CLASS}>{log.attempt}</td>
                            <td className={TD_CLASS}>{log.outcome}</td>
                            <td className={TD_CLASS}>{log.httpStatus ?? "—"}</td>
                            <td className={`${TD_CLASS} font-mono text-xs`}>{log.responseCode ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>

              <div className="md:w-44 md:shrink-0">
                <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  QR preview
                </p>
                <div
                  className="grid aspect-square place-items-center rounded-lg border border-border bg-white p-2"
                  data-testid="tax-qr-preview"
                >
                  {detail?.qrUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={detail.qrUrl} alt="KRA eTIMS QR code" className="size-full object-contain" />
                  ) : (
                    <span className="px-2 text-center text-xs text-muted-foreground">
                      QR appears after acknowledgement
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Generate KRA eTIMS signature"
          description="Finalise a bill, enqueue it and transmit once. KRA allocates the control number."
          testId="tax-generate-panel"
          className="xl:col-span-2"
        >
          <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
            <Field label="Unfinalised invoice">
              <select
                className={INPUT_CLASS}
                value={invoiceId}
                onChange={(event) => setInvoiceId(event.target.value)}
                data-testid="tax-invoice-select"
                aria-label="Invoice to sign"
              >
                <option value="">Select an invoice</option>
                {response?.invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.invoiceNo} · {invoice.patient ?? "Patient"} · {formatMoney(invoice.total)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Buyer KRA PIN" hint="Optional; the patient's payer type is used when blank.">
              <input
                className={INPUT_CLASS}
                value={buyerPin}
                onChange={(event) => setBuyerPin(event.target.value)}
                placeholder="P000000000X"
                maxLength={16}
                data-testid="tax-buyer-pin"
                aria-label="Buyer KRA PIN"
              />
            </Field>
            <Field label="Buyer name">
              <input
                className={INPUT_CLASS}
                value={buyerName}
                onChange={(event) => setBuyerName(event.target.value)}
                placeholder="Optional buyer name"
                data-testid="tax-buyer-name"
                aria-label="Buyer name"
              />
            </Field>
            <Field label="Target">
              <select
                className={INPUT_CLASS}
                value={environment}
                onChange={(event) => setEnvironment(event.target.value as "sandbox" | "production")}
                data-testid="tax-environment"
                aria-label="eTIMS target environment"
              >
                <option value="sandbox">Sandbox (test)</option>
                <option value="production">Production (guarded)</option>
              </select>
            </Field>
            <Button
              type="button"
              className="mt-1 w-full"
              data-testid="tax-generate-signature"
              disabled={!canWrite || !invoiceId || busy}
              onClick={() =>
                void run(
                  "generateEtimsSignature",
                  {
                    invoiceId,
                    environment,
                    buyerPin: buyerPin || null,
                    buyerName: buyerName || null,
                  },
                  "KRA signature generated",
                )
              }
            >
              <Fingerprint className="size-4" aria-hidden /> Generate KRA eTIMS signature
            </Button>
            {!canWrite ? (
              <p className="text-xs text-muted-foreground">Read-only role: transmission actions are disabled.</p>
            ) : null}
          </form>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Tax code master"
          description="Effective-dated codes used to derive tax on each invoice line."
          testId="tax-codes-panel"
        >
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>Code</th>
                  <th className={TH_CLASS}>Treatment</th>
                  <th className={`${TH_CLASS} text-right`}>Rate</th>
                  <th className={TH_CLASS}>Effective</th>
                  <th className={TH_CLASS}>Default</th>
                </tr>
              </thead>
              <tbody>
                {response?.taxCodes.length ? (
                  response.taxCodes.map((code) => (
                    <tr key={code.id}>
                      <td className={`${TD_CLASS} font-mono text-xs`}>
                        {code.code}
                        <span className="block text-[11px] font-normal text-muted-foreground">{code.name}</span>
                      </td>
                      <td className={TD_CLASS}>{taxTreatmentLabel(code.treatment)}</td>
                      <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                        {Number(code.rate).toFixed(2)}%
                      </td>
                      <td className={TD_CLASS}>{code.effectiveFrom}</td>
                      <td className={TD_CLASS}>{code.isDefault ? "Yes" : "—"}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={5} message="No tax codes configured." />
                )}
              </tbody>
            </table>
          </div>

          {canWrite ? (
            <form className="mt-4 grid gap-2 sm:grid-cols-2" onSubmit={(event) => void saveTaxCode(event)}>
              <Field label="Code">
                <input
                  className={INPUT_CLASS}
                  required
                  value={taxCodeDraft.code}
                  onChange={(event) =>
                    setTaxCodeDraft((current) => ({ ...current, code: event.target.value }))
                  }
                  data-testid="tax-code-input"
                  aria-label="Tax code"
                />
              </Field>
              <Field label="Name">
                <input
                  className={INPUT_CLASS}
                  required
                  value={taxCodeDraft.name}
                  onChange={(event) =>
                    setTaxCodeDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  data-testid="tax-code-name"
                  aria-label="Tax code name"
                />
              </Field>
              <Field label="Rate (%)">
                <input
                  className={INPUT_CLASS}
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={taxCodeDraft.rate}
                  onChange={(event) =>
                    setTaxCodeDraft((current) => ({ ...current, rate: event.target.value }))
                  }
                  data-testid="tax-code-rate"
                  aria-label="Tax rate"
                />
              </Field>
              <Field label="Treatment">
                <select
                  className={INPUT_CLASS}
                  value={taxCodeDraft.treatment}
                  onChange={(event) =>
                    setTaxCodeDraft((current) => ({ ...current, treatment: event.target.value }))
                  }
                  data-testid="tax-code-treatment"
                  aria-label="Tax treatment"
                >
                  {TAX_TREATMENTS.map((treatment) => (
                    <option key={treatment} value={treatment}>
                      {taxTreatmentLabel(treatment)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Effective from">
                <input
                  className={INPUT_CLASS}
                  type="date"
                  value={taxCodeDraft.effectiveFrom}
                  onChange={(event) =>
                    setTaxCodeDraft((current) => ({ ...current, effectiveFrom: event.target.value }))
                  }
                  data-testid="tax-code-effective"
                  aria-label="Tax code effective date"
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" size="sm" data-testid="tax-save-code" disabled={busy}>
                  Save tax code
                </Button>
              </div>
            </form>
          ) : null}
        </Panel>

        <Panel
          title="Integration configuration"
          description="Sandbox and production are separate rows. Credentials stay in server environment variables."
          testId="tax-integrations-panel"
        >
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>Environment</th>
                  <th className={TH_CLASS}>Target</th>
                  <th className={TH_CLASS}>Spec</th>
                  <th className={TH_CLASS}>Credential ref</th>
                  <th className={TH_CLASS}>Retries</th>
                  <th className={TH_CLASS}>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {response?.integrations.length ? (
                  response.integrations.map((integration) => (
                    <tr key={integration.id}>
                      <td className={TD_CLASS}>
                        <StatusPill tone={integration.enabled ? "success" : "neutral"}>
                          {integration.environment}
                        </StatusPill>
                      </td>
                      <td className={`${TD_CLASS} font-mono text-[11px]`}>{integration.baseUrl ?? "—"}</td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{integration.specVersion ?? "—"}</td>
                      <td className={`${TD_CLASS} font-mono text-[11px]`}>
                        {integration.credentialRef ?? "—"}
                      </td>
                      <td className={`${TD_CLASS} font-mono tabular-nums`}>
                        {integration.maxAttempts} / [{integration.backoffSeconds.join(", ")}]
                      </td>
                      <td className={TD_CLASS}>{integration.enabled ? "Yes" : "No"}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={6} message="No eTIMS integration configured." />
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Production transmissions stay disabled until the operator switch is enabled in{" "}
            <Link href="/admin/regulatory" className="font-medium text-primary underline">
              regulatory settings
            </Link>
            . {production?.enabled ? "Production is currently enabled." : "Production is currently disabled."}
          </p>
        </Panel>
      </div>

      <div className="tax-print-sheet" data-testid="tax-print-sheet" aria-hidden="true">
        <h1>KRA eTIMS TAX INVOICE</h1>
        <p>{detail?.company ?? ""}</p>
        <hr />
        <dl>
          <div>
            <strong>Invoice:</strong> {detail?.invoiceNo ?? ""}
          </div>
          <div>
            <strong>Date:</strong> {detail ? formatDate(detail.date) : ""}
          </div>
          <div>
            <strong>Control number:</strong> <span data-testid="tax-print-control">{detail?.kraControlNo ?? ""}</span>
          </div>
          <div>
            <strong>KRA signature:</strong> <span data-testid="tax-print-signature">{detail?.kraSignature ?? ""}</span>
          </div>
          <div>
            <strong>CU number:</strong> {detail?.cuNo ?? ""}
          </div>
        </dl>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>Treatment</th>
              <th>Amount</th>
              <th>Tax</th>
            </tr>
          </thead>
          <tbody>
            {(detail?.lines ?? []).map((line) => (
              <tr key={line.lineNo}>
                <td>{line.lineNo}</td>
                <td>{line.description}</td>
                <td>{taxTreatmentLabel(line.taxTreatment)}</td>
                <td>{formatMoney(line.amount)}</td>
                <td>{formatMoney(line.taxAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>Total:</strong> {detail ? formatMoney(detail.amount) : ""}
        </p>
        {detail?.qrUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={detail.qrUrl} alt="KRA QR code" data-testid="tax-print-qr" />
        ) : null}
      </div>
    </div>
  );
}
