"use client";

import {
  AlertTriangle,
  BadgeCheck,
  CircleDollarSign,
  FileClock,
  RefreshCw,
  ReceiptText,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { INPUT_CLASS } from "@/components/finance/finance-primitives";
import { ClaimsPanel } from "@/components/revenue/revenue-claims-panel";
import { PayersPanel } from "@/components/revenue/revenue-payers-panel";
import { PreAuthorizationPanel } from "@/components/revenue/revenue-preauth-panel";
import { SettlementPanel } from "@/components/revenue/revenue-settlement-panel";
import {
  formatMoney,
  type RevenueData,
  type RevenueTab,
} from "@/components/revenue/revenue-types";
import {
  EmptyRow,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import { LoadingPanel } from "@/components/ui/loading-panel";

const EMPTY_DATA: RevenueData = {
  overview: null,
  payers: [],
  contracts: [],
  preAuthorizations: [],
  claims: [],
  claimDetail: null,
  remittances: [],
  denials: [],
  encounters: [],
  patients: [],
};

const TABS: Array<{ id: RevenueTab; label: string }> = [
  { id: "overview", label: "Overview & ageing" },
  { id: "payers", label: "Payers & contracts" },
  { id: "preauth", label: "Pre-authorisations" },
  { id: "claims", label: "Claims" },
  { id: "remittances", label: "Remittances" },
  { id: "denials", label: "Denials" },
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

export function RevenueWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<RevenueData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RevenueTab>("overview");
  const [status, setStatus] = useState("");
  const [payerId, setPayerId] = useState("");
  const [selectedClaimId, setSelectedClaimId] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (payerId) params.set("payerId", payerId);
    if (selectedClaimId) params.set("claimId", selectedClaimId);
    const response = await fetch(`/api/revenue?${params.toString()}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load revenue data (${response.status})`);
    }
    setData((await response.json()) as RevenueData);
  }, [status, payerId, selectedClaimId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load revenue data";
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
          loadError instanceof Error ? loadError.message : "Unable to load revenue data";
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
  const panelProps = {
    data,
    canWrite,
    refresh,
    openTab: setActiveTab,
    selectClaim: setSelectedClaimId,
    selectedClaimId,
  };

  return (
    <div className="space-y-4" data-testid="revenue-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          testId="revenue-kpi-open-claims"
          label="Open claims"
          value={String(overview?.openClaims ?? 0)}
          helper={formatMoney(overview?.openClaimValue ?? "0")}
          icon={<FileClock className="size-4" />}
        />
        <Kpi
          testId="revenue-kpi-outstanding"
          label="Outstanding"
          value={formatMoney(overview?.outstanding ?? "0")}
          helper="Across active claims"
          icon={<CircleDollarSign className="size-4" />}
        />
        <Kpi
          testId="revenue-kpi-paid"
          label="Paid this month"
          value={formatMoney(overview?.paidThisMonth ?? "0")}
          helper="Remittances received"
          icon={<BadgeCheck className="size-4" />}
        />
        <Kpi
          testId="revenue-kpi-denials"
          label="Open denials"
          value={String(overview?.openDenials ?? 0)}
          helper={formatMoney(overview?.denialValue ?? "0")}
          icon={<AlertTriangle className="size-4" />}
          tone={overview && overview.openDenials > 0 ? "danger" : undefined}
        />
        <Kpi
          testId="revenue-kpi-preauth"
          label="Pending pre-auths"
          value={String(overview?.pendingPreAuths ?? 0)}
          helper="Awaiting a decision"
          icon={<ReceiptText className="size-4" />}
        />
        <Kpi
          testId="revenue-kpi-payers"
          label="Active payers"
          value={String(data.payers.filter((payer) => payer.active).length)}
          helper={`${data.contracts.length} contracts`}
          icon={<Users className="size-4" />}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">Claim status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className={`${INPUT_CLASS} w-44`}
            aria-label="Filter claims by status"
            data-testid="revenue-status-filter"
          >
            <option value="">All statuses</option>
            {["draft", "submitted", "accepted", "queried", "resubmitted", "paid", "rejected", "closed"].map(
              (item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">Payer</span>
          <select
            value={payerId}
            onChange={(event) => setPayerId(event.target.value)}
            className={`${INPUT_CLASS} w-52`}
            aria-label="Filter claims by payer"
            data-testid="revenue-payer-filter"
          >
            <option value="">All payers</option>
            {data.payers.map((payer) => (
              <option key={payer.id} value={payer.id}>
                {payer.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="revenue-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
        <Link
          href="/finance/revenue/sha"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--brand-mint)] bg-secondary px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="revenue-sha-workspace-link"
        >
          <ShieldCheck className="size-4" aria-hidden="true" />
          SHA / SHIF workspace
        </Link>
        <p className="ml-auto text-xs text-muted-foreground">
          Filters apply to claims, remittances and denials.
        </p>
      </div>

      <div role="tablist" aria-label="Revenue sections" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`revenue-tab-${tab.id}`}
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
        <LoadingPanel label="Loading revenue data" title="Loading the revenue cycle" rows={4} />
      ) : (
        <div role="tabpanel" className="space-y-4">
          {activeTab === "overview" ? (
            <Panel
              title="Claims ageing"
              description="Unpaid claim value by age, from the date each claim was raised."
              testId="revenue-overview-panel"
              action={
                <button
                  type="button"
                  onClick={() => setActiveTab("claims")}
                  className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
                  data-testid="revenue-open-claims"
                >
                  View claims
                </button>
              }
            >
              <table className={TABLE_CLASS} data-testid="revenue-ageing-table">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>Age band</th>
                    <th className={TH_CLASS}>Claims</th>
                    <th className={TH_CLASS}>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.ageing ?? []).length === 0 ? (
                    <EmptyRow colSpan={3} message="No active claims in the selected period." />
                  ) : (
                    overview?.ageing.map((bucket) => (
                      <tr key={bucket.label}>
                        <td className={TD_CLASS}>{bucket.label}</td>
                        <td className={TD_CLASS}>{bucket.claimCount}</td>
                        <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                          {formatMoney(bucket.outstanding)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div className="mt-4 flex flex-wrap gap-2">
                {(overview?.ageing ?? []).map((bucket) => (
                  <StatusPill key={bucket.label} tone={bucket.claimCount > 0 ? "warning" : "neutral"}>
                    {bucket.label}: {bucket.claimCount}
                  </StatusPill>
                ))}
              </div>
            </Panel>
          ) : null}
          {activeTab === "payers" ? <PayersPanel {...panelProps} /> : null}
          {activeTab === "preauth" ? <PreAuthorizationPanel {...panelProps} /> : null}
          {activeTab === "claims" ? <ClaimsPanel {...panelProps} /> : null}
          {activeTab === "remittances" || activeTab === "denials" ? (
            <SettlementPanel {...panelProps} activeTab={activeTab} />
          ) : null}
        </div>
      )}
    </div>
  );
}
