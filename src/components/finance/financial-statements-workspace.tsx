"use client";

import {
  BarChart3,
  CircleDollarSign,
  Landmark,
  RefreshCw,
  Scale,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

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
import {
  formatDate,
  formatMoney,
  monthStartIso,
  todayIso,
} from "@/components/finance/finance-types";
import type {
  BalanceSheet,
  CashFlowSection,
  CashFlowStatement,
  FinancialStatementsData,
  IncomeStatement,
  StatementSection,
  StatementTab,
  StatementsResponse,
} from "@/components/finance/statements-types";
import { LoadingPanel } from "@/components/ui/loading-panel";

const EMPTY_STATEMENTS: FinancialStatementsData | null = null;

const TABS: Array<{ id: StatementTab; label: string }> = [
  { id: "balance", label: "Balance sheet" },
  { id: "income", label: "Income statement" },
  { id: "cash", label: "Cash flow" },
];

interface KpiProps {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  tone?: "success" | "warning" | "danger";
  testId: string;
}

function Kpi({ label, value, helper, icon, tone, testId }: KpiProps) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-lg ${
          tone === "danger"
            ? "bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
            : tone === "warning"
              ? "bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
              : "bg-secondary text-primary"
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

function StatementLinesTable({
  section,
  testId,
}: {
  section: StatementSection;
  testId: string;
}) {
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th className={TH_CLASS}>Code</th>
            <th className={TH_CLASS}>Account</th>
            <th className={`${TH_CLASS} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {section.lines.length === 0 ? (
            <EmptyRow colSpan={3} message={`No ${section.label.toLowerCase()} balances in this range.`} />
          ) : (
            section.lines.map((line) => (
              <tr key={line.accountId} data-testid={`statement-line-${line.code}`}>
                <td className={`${TD_CLASS} font-mono`}>{line.code}</td>
                <td className={TD_CLASS}>{line.name}</td>
                <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(line.amount)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="bg-muted/50 font-semibold">
            <td className={TD_CLASS} colSpan={2}>
              Total {section.label.toLowerCase()}
            </td>
            <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(section.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function BalanceSheetPanel({ statement }: { statement: BalanceSheet }) {
  const statusTone = statement.balanced ? "success" : "warning";
  return (
    <Panel
      testId="statements-balance-panel"
      title="Balance sheet"
      description={`Position as at ${formatDate(statement.asOf)}, built from ledger balances up to that date.`}
      action={
        <span data-testid="statements-balance-status">
          <StatusPill tone={statusTone}>
            {statement.balanced ? "Balanced" : "Review totals"}
          </StatusPill>
        </span>
      }
    >
      <div className="space-y-5">
        {statement.sections.map((section) => (
          <div key={section.key} className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{section.label}</h3>
            <StatementLinesTable
              section={section}
              testId={`statements-balance-table-${section.key}`}
            />
          </div>
        ))}
        <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Total assets</p>
            <p
              className="mt-0.5 font-mono text-sm font-semibold tabular-nums"
              data-testid="statements-total-assets"
            >
              {formatMoney(statement.totalAssets)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Liabilities + equity</p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
              {formatMoney(statement.totalLiabilitiesAndEquity)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Accumulated surplus</p>
            <p className="mt-0.5 font-mono text-sm tabular-nums">
              {formatMoney(statement.accumulatedSurplus)}
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function IncomeStatementPanel({ statement }: { statement: IncomeStatement }) {
  return (
    <Panel
      testId="statements-income-panel"
      title="Income statement"
      description={`Activity from ${formatDate(statement.from)} to ${formatDate(statement.to)}.`}
      action={<StatusPill tone="info">Net income</StatusPill>}
    >
      <div className="space-y-5">
        <StatementLinesTable section={statement.revenue} testId="statements-income-revenue-table" />
        <StatementLinesTable section={statement.expenses} testId="statements-income-expenses-table" />
        <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Total revenue</p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
              {formatMoney(statement.totalRevenue)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total expenses</p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
              {formatMoney(statement.totalExpenses)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net income</p>
            <p
              className="mt-0.5 font-mono text-base font-semibold tabular-nums text-primary"
              data-testid="statements-net-income"
            >
              {formatMoney(statement.netIncome)}
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CashFlowTable({ section }: { section: CashFlowSection }) {
  return (
    <div className="overflow-x-auto" data-testid={`statements-cash-table-${section.key}`}>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th className={TH_CLASS}>Date</th>
            <th className={TH_CLASS}>Entry</th>
            <th className={TH_CLASS}>Description</th>
            <th className={`${TH_CLASS} text-right`}>Receipts</th>
            <th className={`${TH_CLASS} text-right`}>Payments</th>
          </tr>
        </thead>
        <tbody>
          {section.lines.length === 0 ? (
            <EmptyRow colSpan={5} message={`No ${section.label.toLowerCase()} in this range.`} />
          ) : (
            section.lines.map((line) => (
              <tr key={line.id}>
                <td className={TD_CLASS}>{formatDate(line.date)}</td>
                <td className={`${TD_CLASS} font-mono`}>{line.entryNo}</td>
                <td className={TD_CLASS}>
                  <span className="block max-w-xs truncate" title={line.description}>
                    {line.description}
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {line.accountCode} — {line.accountName}
                  </span>
                </td>
                <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>
                  {line.direction === "receipt" ? formatMoney(line.amount) : "—"}
                </td>
                <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>
                  {line.direction === "payment" ? formatMoney(line.amount) : "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="bg-muted/50 font-semibold">
            <td className={TD_CLASS} colSpan={3}>
              {section.label} net
            </td>
            <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(section.receipts)}</td>
            <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(section.payments)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function CashFlowPanel({ statement }: { statement: CashFlowStatement }) {
  return (
    <Panel
      testId="statements-cash-panel"
      title="Cash flow"
      description={`Direct cash movements from ${formatDate(statement.from)} to ${formatDate(statement.to)}.`}
      action={
        <StatusPill tone={statement.balanced ? "success" : "warning"}>
          {statement.balanced ? "Reconciled" : "Review totals"}
        </StatusPill>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Opening cash</p>
            <p className="mt-0.5 font-mono text-sm tabular-nums">
              {formatMoney(statement.openingCash)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net movement</p>
            <p
              className="mt-0.5 font-mono text-sm font-semibold tabular-nums"
              data-testid="statements-cash-movement"
            >
              {formatMoney(statement.netCashFlow)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Closing cash</p>
            <p className="mt-0.5 font-mono text-sm tabular-nums">
              {formatMoney(statement.closingCash)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Ledger cash</p>
            <p className="mt-0.5 font-mono text-sm tabular-nums">
              {formatMoney(statement.ledgerCash)}
            </p>
          </div>
        </div>
        {statement.sections.map((section) => (
          <div key={section.key} className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{section.label}</h3>
            <CashFlowTable section={section} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function FinancialStatementsWorkspace() {
  const [response, setResponse] = useState<StatementsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StatementTab>("balance");
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [periodId, setPeriodId] = useState("");
  const [dimension, setDimension] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (periodId) params.set("periodId", periodId);
    if (dimension.startsWith("cost:")) {
      params.set("costCenterId", dimension.slice(5));
    } else if (dimension.startsWith("branch:")) {
      params.set("branchId", dimension.slice(7));
    }

    const result = await fetch(`/api/finance/statements?${params.toString()}`, {
      cache: "no-store",
    });
    if (result.status === 401 || result.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!result.ok) {
      const body = (await result.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load statements (${result.status})`);
    }
    setResponse((await result.json()) as StatementsResponse);
  }, [from, to, periodId, dimension]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Unable to load financial statements";
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
        const message =
          loadError instanceof Error ? loadError.message : "Unable to load financial statements";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const statements = response?.statements ?? EMPTY_STATEMENTS;
  const filters = statements?.filters;
  const balanceStatus = statements?.balanceSheet.balanced ? "Balanced" : "Review totals";

  return (
    <div className="space-y-4" data-testid="statements-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          testId="statements-kpi-assets"
          label="Total assets"
          value={formatMoney(statements?.balanceSheet.totalAssets ?? "0")}
          helper={filters ? `As at ${formatDate(filters.asOf)}` : "Balance sheet"}
          icon={<Landmark className="size-4" />}
        />
        <Kpi
          testId="statements-kpi-net-income"
          label="Net income"
          value={formatMoney(statements?.incomeStatement.netIncome ?? "0")}
          helper="Revenue less expenses"
          icon={<BarChart3 className="size-4" />}
        />
        <Kpi
          testId="statements-kpi-cash-movement"
          label="Cash movement"
          value={formatMoney(statements?.cashFlow.netCashFlow ?? "0")}
          helper="Direct cash flow"
          icon={<Wallet className="size-4" />}
        />
        <Kpi
          testId="statements-kpi-balance"
          label="Balance check"
          value={balanceStatus}
          helper={filters?.dimensionLabel ?? "All ledger lines"}
          icon={<Scale className="size-4" />}
          tone={statements?.balanceSheet.balanced ? "success" : "warning"}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <Field label="Fiscal period" className="w-56">
          <select
            className={INPUT_CLASS}
            value={periodId}
            aria-label="Statement period"
            data-testid="statements-period-select"
            onChange={(event) => {
              const value = event.target.value;
              setPeriodId(value);
              const period = response?.periods.find((item) => item.id === value);
              if (period) {
                setFrom(period.startDate);
                setTo(period.endDate);
              }
            }}
          >
            <option value="">Custom range</option>
            {(response?.periods ?? []).map((period) => (
              <option key={period.id} value={period.id}>
                {period.name} · {formatDate(period.startDate)} – {formatDate(period.endDate)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From" className="w-40">
          <input
            type="date"
            className={INPUT_CLASS}
            value={from}
            aria-label="Statement from date"
            data-testid="statements-from"
            onChange={(event) => {
              setPeriodId("");
              setFrom(event.target.value);
            }}
          />
        </Field>
        <Field label="To" className="w-40">
          <input
            type="date"
            className={INPUT_CLASS}
            value={to}
            aria-label="Statement to date"
            data-testid="statements-to"
            onChange={(event) => {
              setPeriodId("");
              setTo(event.target.value);
            }}
          />
        </Field>
        <Field label="Branch / cost centre" className="w-64">
          <select
            className={INPUT_CLASS}
            value={dimension}
            aria-label="Statement dimension"
            data-testid="statements-dimension-select"
            onChange={(event) => setDimension(event.target.value)}
          >
            <option value="">All ledger lines</option>
            {(response?.branches ?? []).length > 0 ? (
              <optgroup label="Branches">
                {(response?.branches ?? []).map((branch) => (
                  <option key={branch.id} value={`branch:${branch.id}`}>
                    {branch.code} — {branch.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {(response?.costCenters ?? []).length > 0 ? (
              <optgroup label="Cost centres">
                {(response?.costCenters ?? []).map((center) => (
                  <option key={center.id} value={`cost:${center.id}`}>
                    {center.code} — {center.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </Field>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="statements-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      {filters?.dimensionLabel ? (
        <p
          className="rounded-lg border border-[var(--status-warning)] bg-[var(--status-warning-background)] px-3 py-2 text-xs text-[var(--status-warning-foreground)]"
          data-testid="statements-dimension-note"
        >
          Filtered to {filters.dimensionLabel}. Dimension views include only ledger lines tagged to
          this branch or cost centre, so totals may not balance when a journal spans dimensions.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border">
        <div role="tablist" aria-label="Financial statements" className="flex flex-wrap gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              data-testid={`statements-tab-${tab.id}`}
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
        <div className="flex items-center gap-3 pb-2 text-xs text-muted-foreground">
          <Link href="/finance" className="font-medium text-primary underline" data-testid="statements-link-finance">
            Finance workspace
          </Link>
          <Link href="/finance/revenue" className="font-medium text-primary underline">
            Revenue cycle
          </Link>
        </div>
      </div>

      {error ? (
        <section
          role="alert"
          className="rounded-xl border border-[var(--status-critical)] bg-[var(--status-critical-background)] p-4 text-sm text-[var(--status-critical-foreground)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
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

      {loading || !statements ? (
        <LoadingPanel label="Loading financial statements" title="Preparing the statements" rows={4} />
      ) : (
        <div role="tabpanel" className="space-y-4">
          {activeTab === "balance" ? <BalanceSheetPanel statement={statements.balanceSheet} /> : null}
          {activeTab === "income" ? <IncomeStatementPanel statement={statements.incomeStatement} /> : null}
          {activeTab === "cash" ? <CashFlowPanel statement={statements.cashFlow} /> : null}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleDollarSign className="size-3.5" aria-hidden="true" />
            Statements are read-only and derive every figure from immutable posted journal lines.
          </p>
        </div>
      )}
    </div>
  );
}
