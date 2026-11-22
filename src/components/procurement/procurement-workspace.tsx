"use client";

import {
  AlertTriangle,
  Boxes,
  CircleDollarSign,
  FileClock,
  Package,
  RefreshCw,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { OrdersPanel } from "@/components/procurement/procurement-orders-panel";
import { ReceivingPanel } from "@/components/procurement/procurement-receiving-panel";
import { RequisitionsPanel } from "@/components/procurement/procurement-requisitions-panel";
import { SourcingPanel } from "@/components/procurement/procurement-sourcing-panel";
import { StockPanel } from "@/components/procurement/procurement-stock-panel";
import { SuppliersPanel } from "@/components/procurement/procurement-suppliers-panel";
import {
  formatMoney,
  type ProcurementData,
  type ProcurementTab,
} from "@/components/procurement/procurement-types";
import { useProcurementCommand } from "@/components/procurement/use-procurement-command";
import { LoadingPanel } from "@/components/ui/loading-panel";

const EMPTY_DATA: ProcurementData = {
  overview: null,
  suppliers: [],
  requisitions: [],
  requisitionDetail: null,
  rfqs: [],
  rfqDetail: null,
  quotes: [],
  purchaseOrders: [],
  purchaseOrderDetail: null,
  goodsReceipts: [],
  goodsReceiptDetail: null,
  supplierInvoices: [],
  supplierInvoiceDetail: null,
  supplierPayments: [],
  items: [],
  stores: [],
  reorderRows: [],
  stockValuation: [],
  expiryReport: [],
  varianceReport: [],
};

const TABS: Array<{ id: ProcurementTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "suppliers", label: "Suppliers" },
  { id: "requisitions", label: "Requisitions" },
  { id: "sourcing", label: "RFQ & quotes" },
  { id: "orders", label: "LPOs" },
  { id: "receiving", label: "GRN & invoices" },
  { id: "stock", label: "Stock & reports" },
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

export function ProcurementWorkspace({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<ProcurementData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProcurementTab>("overview");
  const [requisitionId, setRequisitionId] = useState("");
  const [rfqId, setRfqId] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [goodsReceiptId, setGoodsReceiptId] = useState("");
  const [supplierInvoiceId, setSupplierInvoiceId] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (requisitionId) params.set("requisitionId", requisitionId);
    if (rfqId) params.set("rfqId", rfqId);
    if (purchaseOrderId) params.set("purchaseOrderId", purchaseOrderId);
    if (goodsReceiptId) params.set("goodsReceiptId", goodsReceiptId);
    if (supplierInvoiceId) params.set("supplierInvoiceId", supplierInvoiceId);
    const response = await fetch(`/api/procurement?${params.toString()}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      toast.error("Your session changed. Returning to your workspace.");
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to load procurement data (${response.status})`);
    }
    setData((await response.json()) as ProcurementData);
  }, [requisitionId, rfqId, purchaseOrderId, goodsReceiptId, supplierInvoiceId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await load();
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "Unable to load procurement data";
      setError(message);
      toast.error(message);
    }
  }, [load]);

  const { busy, error: commandError, run, clearError } = useProcurementCommand(refresh);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((loadError) => {
        if (cancelled) return;
        const message =
          loadError instanceof Error ? loadError.message : "Unable to load procurement data";
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
    busy,
    run,
    refresh,
    selectRequisition: setRequisitionId,
    selectRfq: setRfqId,
    selectPurchaseOrder: setPurchaseOrderId,
    selectGoodsReceipt: setGoodsReceiptId,
    selectSupplierInvoice: setSupplierInvoiceId,
  };

  if (loading) return <LoadingPanel label="Loading procurement workspace" />;

  return (
    <div className="space-y-4" data-testid="procurement-workspace">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          testId="procurement-kpi-pending-requisitions"
          label="Pending requisitions"
          value={String(overview?.pendingRequisitions ?? 0)}
          helper="Awaiting a decision"
          icon={<FileClock className="size-4" />}
        />
        <Kpi
          testId="procurement-kpi-open-orders"
          label="Open LPOs"
          value={String(overview?.openPurchaseOrders ?? 0)}
          helper="Draft, approved or partial"
          icon={<ShoppingCart className="size-4" />}
        />
        <Kpi
          testId="procurement-kpi-unpaid"
          label="Supplier debt"
          value={formatMoney(overview?.unpaidInvoiceAmount ?? "0")}
          helper={`${overview?.unpaidInvoiceCount ?? 0} unpaid invoices`}
          icon={<CircleDollarSign className="size-4" />}
        />
        <Kpi
          testId="procurement-kpi-stock-value"
          label="Stock value"
          value={formatMoney(overview?.stockValue ?? "0")}
          helper="At latest batch cost"
          icon={<Wallet className="size-4" />}
        />
        <Kpi
          testId="procurement-kpi-reorder"
          label="Reorder alerts"
          value={String(overview?.reorderAlerts ?? 0)}
          helper="Below minimum levels"
          tone={overview && overview.reorderAlerts > 0 ? "danger" : undefined}
          icon={<Boxes className="size-4" />}
        />
        <Kpi
          testId="procurement-kpi-suppliers"
          label="Suppliers"
          value={String(data.suppliers.length)}
          helper="Registered at this facility"
          icon={<Package className="size-4" />}
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
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Procurement sections">
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
        {activeTab === "suppliers" ? <SuppliersPanel {...panelProps} /> : null}
        {activeTab === "requisitions" ? <RequisitionsPanel {...panelProps} /> : null}
        {activeTab === "sourcing" ? <SourcingPanel {...panelProps} /> : null}
        {activeTab === "orders" ? <OrdersPanel {...panelProps} /> : null}
        {activeTab === "receiving" ? <ReceivingPanel {...panelProps} /> : null}
        {activeTab === "stock" ? <StockPanel {...panelProps} /> : null}
        {activeTab === "overview" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <StockPanel {...panelProps} />
            <ReceivingPanel {...panelProps} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
