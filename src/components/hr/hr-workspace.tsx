"use client";

import {
  AlertTriangle,
  CalendarDays,
  ClipboardCheck,
  FileClock,
  RefreshCw,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ContractsPanel } from "@/components/hr/hr-contracts-panel";
import { EmployeesPanel } from "@/components/hr/hr-employees-panel";
import { LeavePanel } from "@/components/hr/hr-leave-panel";
import { RotaPanel } from "@/components/hr/hr-rota-panel";
import { EMPTY_HR_DATA } from "@/components/hr/hr-constants";
import type { HrData, HrTab } from "@/components/hr/hr-types";
import { useHrCommand } from "@/components/hr/use-hr-command";
import { LoadingPanel } from "@/components/ui/loading-panel";

const TABS: Array<{ id: HrTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "employees", label: "Employees" },
  { id: "contracts", label: "Positions & contracts" },
  { id: "rota", label: "Rota & attendance" },
  { id: "leave", label: "Leave" },
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

export function HrWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<HrData>(EMPTY_HR_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<HrTab>("overview");

  const load = useCallback(async () => {
    const response = await fetch("/api/hr", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load HR data (${response.status})`);
    }
    setData((await response.json()) as HrData);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load HR data";
      setError(message);
      toast.error(message);
    }
  }, [load]);

  const { busy, error: commandError, run, clearError } = useHrCommand(refresh);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((loadError) => {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : "Unable to load HR data";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading) return <LoadingPanel label="Loading HR workspace" />;

  const overview = data.overview;
  const panelProps = { data, canWrite, busy, run };

  return (
    <div className="space-y-4" data-testid="hr-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi
          testId="hr-kpi-active-employees"
          label="Active employees"
          value={String(overview?.activeEmployees ?? 0)}
          helper="On the payroll"
          icon={<Users className="size-4" />}
        />
        <Kpi
          testId="hr-kpi-open-positions"
          label="Open positions"
          value={String(overview?.openPositions ?? 0)}
          helper="Active roles"
          icon={<UserRound className="size-4" />}
        />
        <Kpi
          testId="hr-kpi-pending-leave"
          label="Pending leave"
          value={String(overview?.pendingLeave ?? 0)}
          helper="Awaiting a decision"
          tone={overview && overview.pendingLeave > 0 ? "warning" : undefined}
          icon={<FileClock className="size-4" />}
        />
        <Kpi
          testId="hr-kpi-attendance"
          label="Attendance today"
          value={String(overview?.attendanceToday ?? 0)}
          helper="Records for today"
          icon={<ClipboardCheck className="size-4" />}
        />
        <Kpi
          testId="hr-kpi-contracts-expiring"
          label="Contracts expiring"
          value={String(overview?.contractsExpiring ?? 0)}
          helper="Within 30 days"
          tone={overview && overview.contractsExpiring > 0 ? "warning" : undefined}
          icon={<CalendarDays className="size-4" />}
        />
      </div>

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
        <div className="flex min-w-max gap-1" role="tablist" aria-label="HR sections">
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
        {activeTab === "employees" ? <EmployeesPanel {...panelProps} /> : null}
        {activeTab === "contracts" ? <ContractsPanel {...panelProps} /> : null}
        {activeTab === "rota" ? <RotaPanel {...panelProps} /> : null}
        {activeTab === "leave" ? <LeavePanel {...panelProps} /> : null}
        {activeTab === "overview" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <EmployeesPanel {...panelProps} />
            <LeavePanel {...panelProps} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
