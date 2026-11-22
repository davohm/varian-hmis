"use client";

import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  Clock3,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EMPTY_ASSETS_DATA } from "@/components/assets/assets-constants";
import { ChangesPanel } from "@/components/assets/assets-changes-panel";
import { DepreciationPanel } from "@/components/assets/assets-depreciation-panel";
import { MaintenancePanel } from "@/components/assets/assets-maintenance-panel";
import { RegisterPanel } from "@/components/assets/assets-register-panel";
import {
  formatMoney,
  type AssetsData,
  type AssetsTab,
} from "@/components/assets/assets-types";
import { useAssetsCommand } from "@/components/assets/use-assets-command";
import { LoadingPanel } from "@/components/ui/loading-panel";

const TABS: Array<{ id: AssetsTab; label: string }> = [
  { id: "register", label: "Register" },
  { id: "depreciation", label: "Depreciation" },
  { id: "maintenance", label: "Maintenance" },
  { id: "changes", label: "Valuation & disposal" },
];

interface KpiProps {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  testId: string;
}

function Kpi({ label, value, helper, icon, testId }: KpiProps) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-primary"
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

export function AssetsWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<AssetsData>(EMPTY_ASSETS_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AssetsTab>("register");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const load = useCallback(async (assetId: string | null, runId: string | null) => {
    const params = new URLSearchParams();
    if (assetId) params.set("assetId", assetId);
    if (runId) params.set("runId", runId);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const response = await fetch(`/api/assets${suffix}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load asset data (${response.status})`);
    }
    setData((await response.json()) as AssetsData);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load(selectedAssetId, selectedRunId);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load asset data";
      setError(message);
      toast.error(message);
    }
  }, [load, selectedAssetId, selectedRunId]);

  const { busy, error: commandError, run, clearError } = useAssetsCommand(refresh);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load(selectedAssetId, selectedRunId)
      .catch((loadError) => {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : "Unable to load asset data";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, selectedAssetId, selectedRunId]);

  if (loading) return <LoadingPanel label="Loading assets workspace" />;

  const overview = data.overview;

  return (
    <div className="space-y-4" data-testid="assets-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        <Kpi
          testId="assets-kpi-total"
          label="Assets on register"
          value={String(overview?.totalAssets ?? 0)}
          helper="All recorded assets"
          icon={<Boxes className="size-4" />}
        />
        <Kpi
          testId="assets-kpi-service"
          label="In service"
          value={String(overview?.inService ?? 0)}
          helper="Available for use"
          icon={<ClipboardCheck className="size-4" />}
        />
        <Kpi
          testId="assets-kpi-book-value"
          label="Net book value"
          value={formatMoney(overview?.netBookValue ?? 0)}
          helper="Active assets at carrying value"
          icon={<Boxes className="size-4" />}
        />
        <Kpi
          testId="assets-kpi-approvals"
          label="Pending approvals"
          value={String(overview?.pendingApprovals ?? 0)}
          helper={`${overview?.openMaintenanceOrders ?? 0} open maintenance orders`}
          icon={<Clock3 className="size-4" />}
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
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Asset sections">
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
        {activeTab === "register" ? (
          <RegisterPanel
            data={data}
            canWrite={canWrite}
            busy={busy}
            run={run}
            selectAsset={setSelectedAssetId}
            selectRun={setSelectedRunId}
          />
        ) : null}
        {activeTab === "depreciation" ? (
          <DepreciationPanel
            data={data}
            canWrite={canWrite}
            busy={busy}
            run={run}
            selectAsset={setSelectedAssetId}
            selectRun={setSelectedRunId}
          />
        ) : null}
        {activeTab === "maintenance" ? (
          <MaintenancePanel
            data={data}
            canWrite={canWrite}
            busy={busy}
            run={run}
            selectAsset={setSelectedAssetId}
            selectRun={setSelectedRunId}
          />
        ) : null}
        {activeTab === "changes" ? (
          <ChangesPanel
            data={data}
            canWrite={canWrite}
            busy={busy}
            run={run}
            selectAsset={setSelectedAssetId}
            selectRun={setSelectedRunId}
          />
        ) : null}
      </div>
    </div>
  );
}
