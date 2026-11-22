"use client";

import {
  AlertTriangle,
  BadgeCheck,
  Clock3,
  Percent,
  RefreshCw,
  Users,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { LoadingPanel } from "@/components/ui/loading-panel";
import { EMPTY_PAYROLL_DATA } from "@/components/payroll/payroll-constants";
import { RatesPanel } from "@/components/payroll/payroll-rates-panel";
import { RunsPanel } from "@/components/payroll/payroll-runs-panel";
import {
  formatMoney,
  type PayrollData,
  type PayrollTab,
} from "@/components/payroll/payroll-types";
import { usePayrollCommand } from "@/components/payroll/use-payroll-command";

const TABS: Array<{ id: PayrollTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs & payslips" },
  { id: "rates", label: "Statutory rates" },
];

interface KpiProps {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  tone?: "warning";
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
          tone === "warning"
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

export function PayrollWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<PayrollData>(EMPTY_PAYROLL_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PayrollTab>("overview");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const load = useCallback(async (runId: string | null) => {
    const suffix = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const response = await fetch(`/api/payroll${suffix}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load payroll data (${response.status})`);
    }
    setData((await response.json()) as PayrollData);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load(selectedRunId);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load payroll data";
      setError(message);
      toast.error(message);
    }
  }, [load, selectedRunId]);

  const { busy, error: commandError, run, clearError } = usePayrollCommand(refresh);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load(selectedRunId)
      .catch((loadError) => {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : "Unable to load payroll data";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, selectedRunId]);

  if (loading) return <LoadingPanel label="Loading payroll workspace" />;

  const overview = data.overview;
  const missingRates = overview?.missingRateTypes ?? [];

  return (
    <div className="space-y-4" data-testid="payroll-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi
          testId="payroll-kpi-draft"
          label="Draft runs"
          value={String(overview?.draftRuns ?? 0)}
          helper="Awaiting approval"
          icon={<Clock3 className="size-4" />}
        />
        <Kpi
          testId="payroll-kpi-approved"
          label="Approved"
          value={String(overview?.approvedRuns ?? 0)}
          helper="Awaiting posting"
          icon={<BadgeCheck className="size-4" />}
        />
        <Kpi
          testId="payroll-kpi-posted"
          label="Posted runs"
          value={String(overview?.postedRuns ?? 0)}
          helper="Ledger and slips issued"
          icon={<Wallet className="size-4" />}
        />
        <Kpi
          testId="payroll-kpi-net-pay"
          label="Last net pay"
          value={formatMoney(overview?.lastNetPay ?? 0)}
          helper="Most recent posted run"
          icon={<Wallet className="size-4" />}
        />
        <Kpi
          testId="payroll-kpi-employees"
          label="Active employees"
          value={String(overview?.activeEmployees ?? 0)}
          helper="Eligible to be paid"
          icon={<Users className="size-4" />}
        />
      </div>

      {missingRates.length > 0 ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 text-sm text-[var(--status-warning-foreground)]"
          data-testid="payroll-missing-rates"
        >
          <Percent className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium">Statutory rates are incomplete</p>
            <p className="mt-0.5">
              Missing: {missingRates.join(", ")}. These deductions compute zero until an
              administrator enters the rates. Test-only rows are not payroll evidence.
            </p>
          </div>
        </div>
      ) : null}

      {(error || commandError) && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-[var(--status-critical-border)] bg-[var(--status-critical-background)] p-3 text-sm text-[var(--status-critical-foreground)]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{error ?? commandError}</p>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline"
              onClick={() => {
                clearError();
                void refresh();
              }}
            >
              <RefreshCw className="size-3" aria-hidden="true" />
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm">
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Payroll sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={TABS.find((tab) => tab.id === activeTab)?.label}>
        {activeTab === "overview" ? (
          <RunsPanel
            data={data}
            canWrite={canWrite}
            busy={busy}
            run={run}
            selectRun={(runId) => {
              setActiveTab("runs");
              setSelectedRunId(runId);
            }}
          />
        ) : null}
        {activeTab === "runs" ? (
          <RunsPanel
            data={data}
            canWrite={canWrite}
            busy={busy}
            run={run}
            selectRun={setSelectedRunId}
          />
        ) : null}
        {activeTab === "rates" ? <RatesPanel rates={data.rates} /> : null}
      </div>
    </div>
  );
}
