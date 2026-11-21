"use client";

import {
  CircleDollarSign,
  Landmark,
  Receipt,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { BankingPanel } from "@/components/finance/finance-banking-panel";
import {
  AccountsPanel,
  FiscalPeriodsPanel,
  GeneralLedgerPanel,
  JournalsPanel,
  TrialBalancePanel,
} from "@/components/finance/finance-ledger-panels";
import {
  formatMoney,
  monthStartIso,
  todayIso,
  type FinanceData,
  type FinanceTab,
} from "@/components/finance/finance-types";
import { INPUT_CLASS } from "@/components/finance/finance-primitives";
import { LoadingPanel } from "@/components/ui/loading-panel";

const EMPTY_DATA: FinanceData = {
  overview: null,
  accounts: [],
  costCenters: [],
  periods: [],
  journals: [],
  bankAccounts: [],
  bankTransactions: [],
  reconciliations: [],
  trialBalance: null,
  generalLedger: null,
};

const TABS: Array<{ id: FinanceTab; label: string }> = [
  { id: "accounts", label: "Chart of accounts" },
  { id: "periods", label: "Fiscal periods" },
  { id: "journals", label: "Journals" },
  { id: "trial", label: "Trial balance" },
  { id: "ledger", label: "General ledger" },
  { id: "banking", label: "Banking" },
];

interface KpiProps {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  tone?: "success" | "danger";
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

export function FinanceWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<FinanceData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FinanceTab>("journals");
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [accountId, setAccountId] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (accountId) params.set("accountId", accountId);
    const response = await fetch(`/api/finance?${params.toString()}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load finance data (${response.status})`);
    }
    setData((await response.json()) as FinanceData);
  }, [from, to, accountId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load finance data";
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
          loadError instanceof Error ? loadError.message : "Unable to load finance data";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const overview = data.overview;
  const receivables = formatMoney(
    (Number(overview?.patientReceivable ?? 0) + Number(overview?.insuranceReceivable ?? 0)).toFixed(2),
  );

  const panelProps = {
    data,
    canWrite,
    refresh,
    openTab: setActiveTab,
    accountId,
    onAccountChange: setAccountId,
  };

  return (
    <div className="space-y-4" data-testid="finance-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          testId="finance-kpi-cash"
          label="Cash"
          value={formatMoney(overview?.cash ?? "0")}
          helper="Cash ledger balance"
          icon={<Wallet className="size-4" />}
        />
        <Kpi
          testId="finance-kpi-bank"
          label="Bank"
          value={formatMoney(overview?.bank ?? "0")}
          helper="Per bank ledger"
          icon={<Landmark className="size-4" />}
        />
        <Kpi
          testId="finance-kpi-receivables"
          label="Receivables"
          value={receivables}
          helper="Patient + insurance"
          icon={<Receipt className="size-4" />}
        />
        <Kpi
          testId="finance-kpi-payables"
          label="Payables"
          value={formatMoney(overview?.accountsPayable ?? "0")}
          helper="Outstanding balances"
          icon={<CircleDollarSign className="size-4" />}
        />
        <Kpi
          testId="finance-kpi-revenue"
          label="Revenue"
          value={formatMoney(overview?.revenue ?? "0")}
          helper="Posted service revenue"
          icon={<TrendingUp className="size-4" />}
        />
        <Kpi
          testId="finance-kpi-ledger"
          label="Ledger"
          value={overview?.trialBalanceBalanced ? "Balanced" : "Needs review"}
          helper={`${overview?.journalCount ?? 0} journals · ${overview?.openPeriods ?? 0} open periods`}
          icon={<ShieldCheck className="size-4" />}
          tone={overview && !overview.trialBalanceBalanced ? "danger" : "success"}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">From</span>
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={`${INPUT_CLASS} w-40`}
            aria-label="Finance report from date"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">To</span>
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={`${INPUT_CLASS} w-40`}
            aria-label="Finance report to date"
          />
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="finance-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
          <Link
            href="/finance/statements"
            className="font-medium text-primary underline"
            data-testid="finance-link-statements"
          >
            Financial statements
          </Link>
          <Link href="/finance/budgets" className="font-medium text-primary underline" data-testid="finance-link-budgets">
            Budgets &amp; controls
          </Link>
          <Link href="/finance/revenue" className="font-medium text-primary underline">
            Revenue cycle
          </Link>
          <Link href="/finance/tax" className="font-medium text-primary underline" data-testid="finance-link-tax">
            KRA eTIMS
          </Link>
          <span className="text-muted-foreground">
            Dates filter journals, trial balance and the general ledger.
          </span>
        </div>
      </div>

      <div role="tablist" aria-label="Finance sections" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`finance-tab-${tab.id}`}
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
        <LoadingPanel label="Loading finance data" title="Loading the ledger" rows={4} />
      ) : (
        <div role="tabpanel" className="space-y-4">
          {activeTab === "accounts" ? <AccountsPanel {...panelProps} /> : null}
          {activeTab === "periods" ? <FiscalPeriodsPanel {...panelProps} /> : null}
          {activeTab === "journals" ? <JournalsPanel {...panelProps} /> : null}
          {activeTab === "trial" ? <TrialBalancePanel {...panelProps} /> : null}
          {activeTab === "ledger" ? <GeneralLedgerPanel {...panelProps} /> : null}
          {activeTab === "banking" ? <BankingPanel {...panelProps} /> : null}
        </div>
      )}
    </div>
  );
}
