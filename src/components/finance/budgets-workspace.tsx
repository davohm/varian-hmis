"use client";

import {
  CheckCircle2,
  ClipboardList,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import {
  budgetStatusLabel,
  budgetStatusTone,
  formatMoney,
  type BudgetDraftLine,
  type BudgetsResponse,
  type BudgetRow,
} from "@/components/finance/budgets-types";
import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  NUMERIC_CLASS,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import { formatDate } from "@/components/finance/finance-types";
import { useBudgetCommand } from "@/components/finance/use-budget-command";
import { Button } from "@/components/ui/button";
import { LoadingPanel } from "@/components/ui/loading-panel";
import { BUDGET_STATUSES } from "@/lib/finance";

function emptyLine(): BudgetDraftLine {
  return { accountId: "", costCenterId: "", amount: "", description: "" };
}

interface KpiProps {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  testId: string;
  tone?: "success" | "warning";
}

function Kpi({ label, value, helper, icon, testId, tone }: KpiProps) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-lg ${
          tone === "warning"
            ? "bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
            : "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
        }`}
        aria-hidden="true"
      >
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

export function BudgetsWorkspace({ canWrite }: { canWrite: boolean }) {
  const [response, setResponse] = useState<BudgetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const [formMode, setFormMode] = useState<"create" | "revise" | null>(null);
  const [revisionId, setRevisionId] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [budgetPeriodId, setBudgetPeriodId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [enforce, setEnforce] = useState(true);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<BudgetDraftLine[]>([emptyLine()]);
  const [rejectReason, setRejectReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (periodId) params.set("periodId", periodId);
    if (status) params.set("status", status);
    if (selectedId) params.set("budgetId", selectedId);

    const result = await fetch(`/api/finance/budgets?${params.toString()}`, {
      cache: "no-store",
    });
    if (result.status === 401 || result.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!result.ok) {
      const body = (await result.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load budgets (${result.status})`);
    }
    setResponse((await result.json()) as BudgetsResponse);
  }, [periodId, status, selectedId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load budgets";
      setError(message);
      toast.error(message);
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((loadError) => {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : "Unable to load budgets";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!selectedId && response && response.budgets.length > 0) {
      setSelectedId(response.budgets[0].id);
    }
  }, [response, selectedId]);

  const { busy, error: commandError, run, clearError } = useBudgetCommand(refresh);
  const budget = response?.budget ?? null;
  const summary = response?.summary;
  const availableCostCenters = (response?.costCenters ?? []).filter(
    (center) => !branchId || center.branchId === branchId,
  );

  function resetForm() {
    setCode("");
    setName("");
    setBudgetPeriodId(response?.periods.find((period) => period.status === "open")?.id ?? "");
    setBranchId("");
    setCostCenterId("");
    setEnforce(true);
    setNote("");
    setLines([emptyLine()]);
    setRejectReason("");
  }

  function openCreate() {
    resetForm();
    setRevisionId("");
    setFormMode("create");
    clearError();
  }

  function openRevise(target: BudgetRow) {
    setRevisionId(target.id);
    setCode(target.code);
    setName(target.name);
    setBudgetPeriodId(target.periodId);
    setBranchId(target.branchId ?? "");
    setCostCenterId(target.costCenterId ?? "");
    setEnforce(target.enforce);
    setNote(target.note ?? "");
    setLines(
      (response?.budget?.lines ?? []).map((line) => ({
        accountId: line.accountId,
        costCenterId: line.costCenterId ?? "",
        amount: line.amount,
        description: line.description ?? "",
      })),
    );
    setFormMode("revise");
    clearError();
  }

  function closeForm() {
    setFormMode(null);
    setRevisionId("");
    clearError();
  }

  function updateLine(index: number, patch: Partial<BudgetDraftLine>) {
    setLines((current) =>
      current.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    );
  }

  function linePayload() {
    return lines.map((line) => ({
      accountId: line.accountId,
      costCenterId: line.costCenterId || null,
      amount: line.amount,
      description: line.description.trim() || null,
    }));
  }

  async function submitForm(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      if (formMode === "create") {
        const outcome = await run(
          "createBudget",
          {
            code,
            name,
            periodId: budgetPeriodId,
            branchId: branchId || null,
            costCenterId: costCenterId || null,
            enforce,
            note: note.trim() || null,
            lines: linePayload(),
          },
          "Budget created as a draft",
        );
        if (outcome.ok) {
          const result = outcome.result as { budgetId?: string } | undefined;
          if (result?.budgetId) setSelectedId(result.budgetId);
          closeForm();
        }
      } else if (formMode === "revise") {
        const outcome = await run(
          "replaceBudgetLines",
          { budgetId: revisionId, note: note.trim() || null, lines: linePayload() },
          "Budget revised",
        );
        if (outcome.ok) closeForm();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function workflowCommand(command: string, input: Record<string, unknown>, message: string) {
    const outcome = await run(command, { budgetId: selectedId, ...input }, message);
    if (outcome.ok && command === "rejectBudget") setRejectReason("");
    return outcome.ok;
  }

  return (
    <div className="space-y-4" data-testid="budgets-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          testId="budgets-kpi-approved"
          label="Approved budget"
          value={formatMoney(summary?.total ?? "0")}
          helper={`${summary?.approvedCount ?? 0} approved budgets`}
          icon={<ClipboardList className="size-4" />}
        />
        <Kpi
          testId="budgets-kpi-actual"
          label="Posted actual"
          value={formatMoney(summary?.actual ?? "0")}
          helper="Expense lines in period"
          icon={<Wallet className="size-4" />}
        />
        <Kpi
          testId="budgets-kpi-remaining"
          label="Remaining"
          value={formatMoney(summary?.remaining ?? "0")}
          helper="Approved budget less actual"
          icon={<ShieldCheck className="size-4" />}
          tone={Number(summary?.remaining ?? 0) < 0 ? "warning" : undefined}
        />
        <Kpi
          testId="budgets-kpi-pending"
          label="Awaiting approval"
          value={`${summary?.pendingCount ?? 0}`}
          helper="Submitted budgets"
          icon={<CheckCircle2 className="size-4" />}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <Field label="Fiscal period" className="w-64">
          <select
            className={INPUT_CLASS}
            value={periodId}
            aria-label="Budget period filter"
            data-testid="budgets-period-filter"
            onChange={(event) => setPeriodId(event.target.value)}
          >
            <option value="">All periods</option>
            {(response?.periods ?? []).map((period) => (
              <option key={period.id} value={period.id}>
                {period.name} · {formatDate(period.startDate)} – {formatDate(period.endDate)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status" className="w-52">
          <select
            className={INPUT_CLASS}
            value={status}
            aria-label="Budget status filter"
            data-testid="budgets-status-filter"
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {BUDGET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {budgetStatusLabel(value)}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="budgets-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
          <Link href="/finance" className="font-medium text-primary underline" data-testid="budgets-link-finance">
            Finance workspace
          </Link>
          <Link href="/finance/statements" className="font-medium text-primary underline" data-testid="budgets-link-statements">
            Financial statements
          </Link>
        </div>
      </div>

      {error || commandError ? (
        <section
          role="alert"
          className="rounded-xl border border-[var(--status-critical)] bg-[var(--status-critical-background)] p-4 text-sm text-[var(--status-critical-foreground)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error ?? commandError}</span>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-current px-3 text-xs font-medium"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Try again
            </button>
          </div>
        </section>
      ) : null}

      {loading ? (
        <LoadingPanel label="Loading budgets" title="Preparing the budget register" rows={4} />
      ) : (
        <div className="space-y-4">
          <Panel
            testId="budgets-register-panel"
            title="Budget register"
            description="Expense plans by fiscal period. Only approved budgets with enforcement block posting."
            action={
              canWrite ? (
                <Button size="sm" onClick={openCreate} data-testid="budgets-new-button">
                  <Plus /> New budget
                </Button>
              ) : null
            }
          >
            <div className="overflow-x-auto" data-testid="budgets-table">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th className={TH_CLASS}>Code</th>
                    <th className={TH_CLASS}>Budget</th>
                    <th className={TH_CLASS}>Period</th>
                    <th className={TH_CLASS}>Status</th>
                    <th className={`${TH_CLASS} text-right`}>Budget</th>
                    <th className={`${TH_CLASS} text-right`}>Actual</th>
                    <th className={`${TH_CLASS} text-right`}>Variance</th>
                    <th className={TH_CLASS}>Control</th>
                  </tr>
                </thead>
                <tbody>
                  {(response?.budgets ?? []).length === 0 ? (
                    <EmptyRow colSpan={8} message="No budgets in this facility yet." />
                  ) : (
                    (response?.budgets ?? []).map((row) => (
                      <tr
                        key={row.id}
                        data-testid={`budgets-row-${row.code}`}
                        onClick={() => setSelectedId(row.id)}
                        className={`cursor-pointer transition-colors hover:bg-muted/60 ${
                          selectedId === row.id ? "bg-muted/60" : ""
                        }`}
                      >
                        <td className={`${TD_CLASS} font-mono`}>{row.code}</td>
                        <td className={TD_CLASS}>
                          <span className="block font-medium">{row.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            v{row.version} · {row.lineCount} lines
                          </span>
                        </td>
                        <td className={TD_CLASS}>
                          <span className="block">{row.periodName}</span>
                          <span className="block text-xs text-muted-foreground">
                            {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
                          </span>
                        </td>
                        <td className={TD_CLASS}>
                          <StatusPill tone={budgetStatusTone(row.status)}>
                            {budgetStatusLabel(row.status)}
                          </StatusPill>
                        </td>
                        <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(row.total, row.currency)}</td>
                        <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(row.actual, row.currency)}</td>
                        <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(row.variance, row.currency)}</td>
                        <td className={TD_CLASS}>
                          <StatusPill tone={row.enforce ? "success" : "neutral"}>
                            {row.enforce ? "Enforced" : "Advisory"}
                          </StatusPill>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {formMode && canWrite ? (
            <Panel
              testId="budgets-form"
              title={formMode === "create" ? "New expense budget" : `Revise ${code}`}
              description={
                formMode === "create"
                  ? "Budgets start as drafts. Submit them for approval before they can control posting."
                  : "Replacing lines creates a new version. Approved budgets cannot be revised."
              }
            >
              <form onSubmit={(event) => void submitForm(event)} className="space-y-4">
                {formMode === "create" ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    <Field label="Code">
                      <input
                        className={INPUT_CLASS}
                        value={code}
                        onChange={(event) => setCode(event.target.value.toUpperCase())}
                        aria-label="Budget code"
                        data-testid="budgets-code"
                        required
                      />
                    </Field>
                    <Field label="Name">
                      <input
                        className={INPUT_CLASS}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        aria-label="Budget name"
                        data-testid="budgets-name"
                        required
                      />
                    </Field>
                    <Field label="Fiscal period">
                      <select
                        className={INPUT_CLASS}
                        value={budgetPeriodId}
                        onChange={(event) => setBudgetPeriodId(event.target.value)}
                        aria-label="Budget fiscal period"
                        data-testid="budgets-period"
                        required
                      >
                        <option value="">Select period…</option>
                        {(response?.periods ?? []).map((period) => (
                          <option key={period.id} value={period.id}>
                            {period.name} · {formatDate(period.startDate)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Branch" hint="Optional facility-wide scope">
                      <select
                        className={INPUT_CLASS}
                        value={branchId}
                        onChange={(event) => {
                          setBranchId(event.target.value);
                          setCostCenterId("");
                        }}
                        aria-label="Budget branch"
                        data-testid="budgets-branch"
                      >
                        <option value="">All branches</option>
                        {(response?.branches ?? []).map((branch) => (
                          <option key={branch.id} value={branch.id}>
                            {branch.code} — {branch.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Cost centre" hint="Optional budget owner">
                      <select
                        className={INPUT_CLASS}
                        value={costCenterId}
                        onChange={(event) => setCostCenterId(event.target.value)}
                        aria-label="Budget cost centre"
                        data-testid="budgets-cost-center"
                      >
                        <option value="">No cost centre</option>
                        {availableCostCenters.map((center) => (
                          <option key={center.id} value={center.id}>
                            {center.code} — {center.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Posting control">
                      <select
                        className={INPUT_CLASS}
                        value={enforce ? "true" : "false"}
                        onChange={(event) => setEnforce(event.target.value === "true")}
                        aria-label="Budget enforcement"
                        data-testid="budgets-enforce"
                      >
                        <option value="true">Block overspend</option>
                        <option value="false">Advisory only</option>
                      </select>
                    </Field>
                    <Field label="Note" className="md:col-span-3">
                      <input
                        className={INPUT_CLASS}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        aria-label="Budget note"
                        data-testid="budgets-note"
                        maxLength={1000}
                        placeholder="Optional context for reviewers"
                      />
                    </Field>
                  </div>
                ) : null}

                <div className="space-y-3" data-testid="budgets-lines">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">Expense lines</h3>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="budgets-line-add"
                      onClick={() => setLines((current) => [...current, emptyLine()])}
                    >
                      <Plus /> Add line
                    </Button>
                  </div>
                  {lines.map((line, index) => (
                    <div
                      key={index}
                      className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-[2fr_1.5fr_1fr_2fr_auto]"
                      data-testid={`budgets-line-${index}`}
                    >
                      <Field label="Expense account">
                        <select
                          className={INPUT_CLASS}
                          value={line.accountId}
                          onChange={(event) => updateLine(index, { accountId: event.target.value })}
                          aria-label={`Budget line ${index + 1} account`}
                          data-testid={`budgets-line-account-${index}`}
                          required
                        >
                          <option value="">Select account…</option>
                          {(response?.accounts ?? []).map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.code} — {account.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Cost centre">
                        <select
                          className={INPUT_CLASS}
                          value={line.costCenterId}
                          onChange={(event) => updateLine(index, { costCenterId: event.target.value })}
                          aria-label={`Budget line ${index + 1} cost centre`}
                          data-testid={`budgets-line-cost-center-${index}`}
                        >
                          <option value="">Facility-wide</option>
                          {availableCostCenters.map((center) => (
                            <option key={center.id} value={center.id}>
                              {center.code} — {center.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Amount">
                        <input
                          className={INPUT_CLASS}
                          inputMode="decimal"
                          value={line.amount}
                          onChange={(event) => updateLine(index, { amount: event.target.value })}
                          aria-label={`Budget line ${index + 1} amount`}
                          data-testid={`budgets-line-amount-${index}`}
                          placeholder="0.00"
                          required
                        />
                      </Field>
                      <Field label="Description">
                        <input
                          className={INPUT_CLASS}
                          value={line.description}
                          onChange={(event) => updateLine(index, { description: event.target.value })}
                          aria-label={`Budget line ${index + 1} description`}
                          data-testid={`budgets-line-description-${index}`}
                          maxLength={500}
                          placeholder="Optional"
                        />
                      </Field>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Remove budget line ${index + 1}`}
                        data-testid={`budgets-line-remove-${index}`}
                        disabled={lines.length === 1}
                        onClick={() =>
                          setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>

                {formMode === "revise" ? (
                  <Field label="Revision note">
                    <input
                      className={INPUT_CLASS}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      aria-label="Budget revision note"
                      data-testid="budgets-revision-note"
                      maxLength={1000}
                    />
                  </Field>
                ) : null}

                <div className="flex gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy || submitting}
                    data-testid="budgets-form-submit"
                  >
                    {formMode === "create" ? "Create draft" : "Save revision"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={closeForm} data-testid="budgets-form-cancel">
                    Cancel
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}

          <Panel
            testId="budgets-detail-panel"
            title={budget ? `${budget.code} — ${budget.name}` : "Budget detail"}
            description={
              budget
                ? `${budget.periodName} · ${formatDate(budget.periodStart)} – ${formatDate(budget.periodEnd)}`
                : "Select a budget to see line-level actuals and controls."
            }
            action={
              budget ? (
                <div className="flex items-center gap-2" data-testid="budgets-detail-status">
                  <StatusPill tone={budgetStatusTone(budget.status)}>
                    {budgetStatusLabel(budget.status)}
                  </StatusPill>
                  <StatusPill tone={budget.enforce ? "success" : "neutral"}>
                    {budget.enforce ? "Enforced" : "Advisory"}
                  </StatusPill>
                </div>
              ) : null
            }
          >
            {!budget ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No budget selected.
              </p>
            ) : (
              <div className="space-y-4" data-testid="budgets-detail">
                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Approved / planned</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums" data-testid="budgets-detail-total">
                      {formatMoney(budget.total, budget.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Posted actual</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums" data-testid="budgets-detail-actual">
                      {formatMoney(budget.actual, budget.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Remaining</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums" data-testid="budgets-detail-variance">
                      {formatMoney(budget.variance, budget.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Version</p>
                    <p className="mt-0.5 font-mono text-sm tabular-nums">{budget.version}</p>
                  </div>
                </div>

                {budget.rejectedReason ? (
                  <p className="rounded-lg border border-[var(--status-critical)] bg-[var(--status-critical-background)] px-3 py-2 text-xs text-[var(--status-critical-foreground)]">
                    Rejected: {budget.rejectedReason}
                  </p>
                ) : null}
                {budget.note ? (
                  <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {budget.note}
                  </p>
                ) : null}

                <div className="overflow-x-auto" data-testid="budgets-detail-lines">
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>Account</th>
                        <th className={TH_CLASS}>Cost centre</th>
                        <th className={`${TH_CLASS} text-right`}>Budget</th>
                        <th className={`${TH_CLASS} text-right`}>Actual</th>
                        <th className={`${TH_CLASS} text-right`}>Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {budget.lines.length === 0 ? (
                        <EmptyRow colSpan={5} message="This budget has no lines." />
                      ) : (
                        budget.lines.map((line) => (
                          <tr key={line.id} data-testid={`budgets-detail-line-${line.accountCode}`}>
                            <td className={TD_CLASS}>
                              <span className="block font-mono text-xs">{line.accountCode}</span>
                              <span className="block">{line.accountName}</span>
                            </td>
                            <td className={TD_CLASS}>{line.costCenterCode ?? "Facility-wide"}</td>
                            <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(line.amount, budget.currency)}</td>
                            <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(line.actual, budget.currency)}</td>
                            <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(line.variance, budget.currency)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {canWrite ? (
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    {(budget.status === "draft" || budget.status === "rejected") ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        data-testid="budgets-submit"
                        onClick={() => void workflowCommand("submitBudget", {}, "Budget submitted for approval")}
                      >
                        Submit for approval
                      </Button>
                    ) : null}
                    {budget.status === "draft" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="budgets-revise"
                        onClick={() => openRevise(budget)}
                      >
                        Revise lines
                      </Button>
                    ) : null}
                    {budget.status === "submitted" ? (
                      <>
                        <input
                          className={`${INPUT_CLASS} w-64`}
                          value={rejectReason}
                          onChange={(event) => setRejectReason(event.target.value)}
                          aria-label="Budget rejection reason"
                          data-testid="budgets-reject-reason"
                          placeholder="Reason for rejection"
                        />
                        <Button
                          size="sm"
                          disabled={busy}
                          data-testid="budgets-reject"
                          onClick={() =>
                            void workflowCommand(
                              "rejectBudget",
                              { reason: rejectReason },
                              "Budget rejected",
                            )
                          }
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          data-testid="budgets-approve"
                          onClick={() =>
                            void workflowCommand(
                              "approveBudget",
                              { enforce: true },
                              "Budget approved and enforced",
                            )
                          }
                        >
                          Approve
                        </Button>
                      </>
                    ) : null}
                    {budget.status === "approved" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="budgets-enforcement"
                        onClick={() =>
                          void workflowCommand(
                            "setBudgetEnforcement",
                            { enforce: !budget.enforce },
                            budget.enforce ? "Posting control paused" : "Posting control enabled",
                          )
                        }
                      >
                        {budget.enforce ? "Pause posting control" : "Enable posting control"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </Panel>

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Budget lines are expense-only. Actual spend and variance derive from posted journal
            lines, including reversals.
          </p>
        </div>
      )}
    </div>
  );
}
