"use client";

import {
  AlertTriangle,
  ArrowLeftRight,
  Boxes,
  CheckCircle2,
  PackagePlus,
  Pill,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  allocateFefo,
  canDispensePrescription,
  canReverseDispense,
  itemDisplayName,
  type DispenseLabel,
} from "@/lib/pharmacy";
import { ageFromDob } from "@/lib/triage";
import type {
  AvailableBatch,
  DispenseRecord,
  PharmacyStore,
  PrescriptionDetail,
  PrescriptionQueueItem,
  StockItemOption,
  StockRow,
} from "@/server/queries/pharmacy";
import { cn } from "cn";

const CARD_CLASS = "rounded-lg border border-border bg-card";
const SECTION_TITLE_CLASS = "text-sm font-semibold";
const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30";

const STATUS_STYLES: Record<string, string> = {
  prescribed: "border-border bg-secondary text-secondary-foreground",
  partial:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  dispensed:
    "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  cancelled: "border-border bg-muted text-muted-foreground",
};

type Tab = "queue" | "stock";

class SessionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMismatchError";
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "pharmacy-station" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
      detail?: string;
      issues?: Array<{ message?: string }>;
    } | null;
    const message =
      detail?.issues?.[0]?.message ??
      detail?.detail ??
      detail?.error ??
      `Request failed (${response.status})`;
    if (response.status === 401 || response.status === 403) {
      throw new SessionMismatchError(message);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function handleSessionMismatch(error: unknown): Promise<boolean> {
  if (!(error instanceof SessionMismatchError)) return false;
  toast.error("Your session changed. Returning to your workspace.");
  window.location.assign("/");
  return true;
}

function formatDate(value: string | null): string {
  if (!value) return "No expiry";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function patientAge(dob: string | null): string {
  const age = ageFromDob(dob);
  return age == null ? "Age unknown" : `${age} yrs`;
}

function rxDisplayName(entry: PrescriptionQueueItem): string {
  return itemDisplayName({ name: entry.itemName, strength: entry.strength, form: entry.form });
}

function toNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** FEFO suggestion: which batch each unit would come from for a given quantity. */
function fefoPlan(
  batches: AvailableBatch[],
  quantity: number,
): Array<{ batch: AvailableBatch; quantity: number }> {
  const usable = batches.filter((batch) => !batch.expired && batch.available > 0);
  const allocations = allocateFefo(
    usable.map((batch) => ({ batchId: batch.id, available: batch.available })),
    quantity,
  );
  return allocations.map((allocation) => ({
    batch: usable.find((batch) => batch.id === allocation.batchId)!,
    quantity: allocation.quantity,
  }));
}

export function PharmacyWorkspace() {
  const [tab, setTab] = useState<Tab>("queue");
  const [busy, setBusy] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /* Dispense queue                                                    */
  /* ---------------------------------------------------------------- */

  const [prescriptions, setPrescriptions] = useState<PrescriptionQueueItem[]>([]);
  const [queueSearch, setQueueSearch] = useState("");
  const [debouncedQueueSearch, setDebouncedQueueSearch] = useState("");
  const [queueLoading, setQueueLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null);
  const [dispenseQuantity, setDispenseQuantity] = useState("");
  const [dispenseNote, setDispenseNote] = useState("");
  const [reverseNote, setReverseNote] = useState("");
  const [lastLabel, setLastLabel] = useState<DispenseLabel | null>(null);

  /* ---------------------------------------------------------------- */
  /* Stock                                                             */
  /* ---------------------------------------------------------------- */

  const [stock, setStock] = useState<StockRow[]>([]);
  const [stores, setStores] = useState<PharmacyStore[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [debouncedStockSearch, setDebouncedStockSearch] = useState("");
  const [stockStoreId, setStockStoreId] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [items, setItems] = useState<StockItemOption[]>([]);
  const [itemSearch, setItemSearch] = useState("");
  const [receiveForm, setReceiveForm] = useState({
    itemId: "",
    batchNo: "",
    expiryDate: "",
    quantity: "",
    unitCost: "",
    note: "",
  });
  const [adjustForm, setAdjustForm] = useState({ qtyDelta: "", note: "" });
  const [transferForm, setTransferForm] = useState({ toStoreId: "", quantity: "", note: "" });

  const selectedRef = useRef<string | null>(null);
  const keysRef = useRef<Record<string, string>>({});

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  function keyFor(scope: string): string {
    if (!keysRef.current[scope]) keysRef.current[scope] = crypto.randomUUID();
    return keysRef.current[scope];
  }

  function clearKey(scope: string): void {
    delete keysRef.current[scope];
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQueueSearch(queueSearch), 250);
    return () => clearTimeout(timer);
  }, [queueSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedStockSearch(stockSearch), 250);
    return () => clearTimeout(timer);
  }, [stockSearch]);

  const loadQueue = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedQueueSearch.trim()) params.set("q", debouncedQueueSearch.trim());
      const response = await fetch(`/api/pharmacy/queue?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as { prescriptions: PrescriptionQueueItem[] };
      setPrescriptions(data.prescriptions);
    } finally {
      setQueueLoading(false);
    }
  }, [debouncedQueueSearch]);

  const loadDetail = useCallback(async (prescriptionId: string, resetQuantity: boolean) => {
    const response = await fetch(`/api/pharmacy/prescriptions/${prescriptionId}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      setDetail(null);
      return;
    }
    const data = (await response.json()) as PrescriptionDetail;
    setDetail(data);
    if (resetQuantity) {
      setDispenseQuantity(String(data.prescription.remaining));
      setDispenseNote("");
      setReverseNote("");
    }
  }, []);

  const loadStock = useCallback(async () => {
    const params = new URLSearchParams();
    if (stockStoreId) params.set("storeId", stockStoreId);
    if (debouncedStockSearch.trim()) params.set("q", debouncedStockSearch.trim());
    const response = await fetch(`/api/pharmacy/stock?${params.toString()}`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = (await response.json()) as { stock: StockRow[]; stores: PharmacyStore[] };
    setStock(data.stock);
    setStores(data.stores);
  }, [stockStoreId, debouncedStockSearch]);

  const loadItems = useCallback(async (term: string) => {
    const params = new URLSearchParams();
    if (term.trim()) params.set("q", term.trim());
    const response = await fetch(`/api/pharmacy/items?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { items: StockItemOption[] };
    setItems(data.items);
  }, []);

  useEffect(() => {
    void loadQueue();
    const interval = setInterval(() => void loadQueue(), 30_000);
    const source = new EventSource("/api/events");
    const onQueue = () => void loadQueue();
    const onDetail = () => {
      void loadQueue();
      const current = selectedRef.current;
      if (current) void loadDetail(current, false);
    };
    const queueEvents = [
      "prescription_created",
      "prescription_dispensed",
      "prescription_reversed",
      "prescription_cancelled",
      "queue_changed",
      "encounter_closed",
    ];
    for (const event of queueEvents) source.addEventListener(event, onDetail);
    source.addEventListener("stock_received", onQueue);
    source.addEventListener("stock_adjusted", onQueue);
    source.addEventListener("stock_transferred", onQueue);
    return () => {
      clearInterval(interval);
      for (const event of queueEvents) source.removeEventListener(event, onDetail);
      source.removeEventListener("stock_received", onQueue);
      source.removeEventListener("stock_adjusted", onQueue);
      source.removeEventListener("stock_transferred", onQueue);
      source.close();
    };
  }, [loadQueue, loadDetail]);

  useEffect(() => {
    void loadStock();
  }, [loadStock]);

  useEffect(() => {
    void loadItems("");
  }, [loadItems]);

  useEffect(() => {
    const timer = setTimeout(() => void loadItems(itemSearch), 250);
    return () => clearTimeout(timer);
  }, [itemSearch, loadItems]);

  async function runAction(
    label: string,
    scope: string,
    action: () => Promise<unknown>,
    successMessage: string,
  ): Promise<boolean> {
    setBusy(label);
    try {
      await action();
      clearKey(scope);
      toast.success(successMessage);
      return true;
    } catch (error) {
      if (await handleSessionMismatch(error)) return false;
      toast.error(error instanceof Error ? error.message : "The request could not be completed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function selectPrescription(entry: PrescriptionQueueItem): void {
    setSelectedId(entry.prescriptionId);
    selectedRef.current = entry.prescriptionId;
    setLastLabel(null);
    void loadDetail(entry.prescriptionId, true);
  }

  async function dispense(): Promise<void> {
    if (!detail) return;
    const quantity = toNumber(dispenseQuantity);
    if (quantity == null || quantity <= 0) {
      toast.error("Enter how many units to dispense");
      return;
    }
    if (quantity > detail.prescription.remaining) {
      toast.error(`Only ${detail.prescription.remaining} remaining on this prescription`);
      return;
    }
    const scope = `dispense:${detail.prescription.prescriptionId}`;
    const result = await runAction(
      scope,
      scope,
      () =>
        postJson<{ label: DispenseLabel }>("/api/pharmacy/dispense", {
          prescriptionId: detail.prescription.prescriptionId,
          quantity,
          note: dispenseNote.trim() || null,
          idempotencyKey: keyFor(scope),
        }).then((response) => {
          setLastLabel(response.label);
          return response;
        }),
      "Dispensed and label ready to print",
    );
    if (result) {
      await loadQueue();
      await loadStock();
      await loadDetail(detail.prescription.prescriptionId, true);
    }
  }

  async function reverse(): Promise<void> {
    if (!detail) return;
    if (!reverseNote.trim()) {
      toast.error("A reason is required to reverse a dispense");
      return;
    }
    const scope = `reverse:${detail.prescription.prescriptionId}`;
    const done = await runAction(
      scope,
      scope,
      () =>
        postJson("/api/pharmacy/reverse", {
          prescriptionId: detail.prescription.prescriptionId,
          note: reverseNote.trim(),
          idempotencyKey: keyFor(scope),
        }),
      "Dispense reversed and stock restored",
    );
    if (done) {
      setLastLabel(null);
      await loadQueue();
      await loadStock();
      await loadDetail(detail.prescription.prescriptionId, true);
    }
  }

  async function receive(): Promise<void> {
    const quantity = toNumber(receiveForm.quantity);
    if (!receiveForm.itemId) {
      toast.error("Choose the item being received");
      return;
    }
    if (!receiveForm.batchNo.trim()) {
      toast.error("Enter the batch number");
      return;
    }
    if (quantity == null || quantity <= 0) {
      toast.error("Enter the quantity received");
      return;
    }
    const scope = "receive";
    const done = await runAction(
      scope,
      scope,
      () =>
        postJson("/api/pharmacy/receive", {
          itemId: receiveForm.itemId,
          batchNo: receiveForm.batchNo.trim(),
          expiryDate: receiveForm.expiryDate || null,
          quantity,
          unitCost: receiveForm.unitCost ? Number(receiveForm.unitCost) : undefined,
          note: receiveForm.note.trim() || null,
          storeId: stockStoreId || undefined,
          idempotencyKey: keyFor(scope),
        }),
      "Stock received",
    );
    if (done) {
      setReceiveForm({
        itemId: "",
        batchNo: "",
        expiryDate: "",
        quantity: "",
        unitCost: "",
        note: "",
      });
      await loadStock();
    }
  }

  async function adjust(): Promise<void> {
    if (!selectedBatchId) {
      toast.error("Select a batch from the stock list first");
      return;
    }
    const delta = toNumber(adjustForm.qtyDelta);
    if (delta == null || delta === 0) {
      toast.error("Enter a non-zero adjustment");
      return;
    }
    if (!adjustForm.note.trim()) {
      toast.error("A reason is required for a stock adjustment");
      return;
    }
    const scope = `adjust:${selectedBatchId}`;
    const done = await runAction(
      scope,
      scope,
      () =>
        postJson("/api/pharmacy/adjust", {
          batchId: selectedBatchId,
          qtyDelta: delta,
          note: adjustForm.note.trim(),
          storeId: stockStoreId || undefined,
          idempotencyKey: keyFor(scope),
        }),
      "Stock adjusted",
    );
    if (done) {
      setAdjustForm({ qtyDelta: "", note: "" });
      await loadStock();
    }
  }

  async function transfer(): Promise<void> {
    const row = stock.find((entry) => entry.batchId === selectedBatchId);
    if (!row) {
      toast.error("Select a batch from the stock list first");
      return;
    }
    const quantity = toNumber(transferForm.quantity);
    if (!transferForm.toStoreId) {
      toast.error("Choose the destination store");
      return;
    }
    if (quantity == null || quantity <= 0) {
      toast.error("Enter the quantity to transfer");
      return;
    }
    const scope = `transfer:${row.batchId}`;
    const done = await runAction(
      scope,
      scope,
      () =>
        postJson("/api/pharmacy/transfer", {
          fromStoreId: row.storeId,
          toStoreId: transferForm.toStoreId,
          batchId: row.batchId,
          quantity,
          note: transferForm.note.trim() || null,
          idempotencyKey: keyFor(scope),
        }),
      "Stock transferred",
    );
    if (done) {
      setTransferForm({ toStoreId: "", quantity: "", note: "" });
      await loadStock();
    }
  }

  function printLabel(): void {
    if (!lastLabel) return;
    const popup = window.open("", "_blank", "width=420,height=640");
    if (!popup) {
      toast.error("Allow pop-ups to print the label");
      return;
    }
    popup.document.write(
      `<!doctype html><html><head><title>Dispense label</title><style>
        body{font-family:ui-sans-serif,system-ui,sans-serif;padding:16px;color:#022f5b}
        h1{font-size:16px;margin:0 0 4px}
        .muted{color:#555;font-size:12px}
        .row{margin-top:10px;font-size:13px}
        .dose{font-size:18px;font-weight:600;margin-top:12px}
        hr{border:none;border-top:1px dashed #999;margin:12px 0}
      </style></head><body>
        <h1>${lastLabel.facilityName}</h1>
        <p class="muted">${lastLabel.patientName} · ${lastLabel.mrn} · ${lastLabel.encounterNo}</p>
        <hr/>
        <p class="dose">${lastLabel.itemName}${lastLabel.strength ? ` — ${lastLabel.strength}` : ""}${lastLabel.form ? ` (${lastLabel.form})` : ""}</p>
        <p class="row">Take ${lastLabel.dose} ${lastLabel.route} · ${lastLabel.frequency}${lastLabel.durationDays ? ` · ${lastLabel.durationDays} days` : ""}</p>
        <p class="row">Quantity dispensed: ${lastLabel.quantity} ${lastLabel.unit}</p>
        ${lastLabel.instructions ? `<p class="row">${lastLabel.instructions}</p>` : ""}
        <hr/>
        <p class="muted">Dispensed ${formatDateTime(lastLabel.dispensedAt)}</p>
      </body></html>`,
    );
    popup.document.close();
    popup.focus();
    popup.print();
  }

  const selectedBatch = stock.find((row) => row.batchId === selectedBatchId) ?? null;
  const plan = detail ? fefoPlan(detail.batches, toNumber(dispenseQuantity) ?? 0) : [];
  const planTotal = plan.reduce((total, entry) => total + entry.quantity, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Pharmacy view">
        <Button
          type="button"
          size="sm"
          variant={tab === "queue" ? "default" : "outline"}
          data-testid="pharmacy-tab-queue"
          aria-pressed={tab === "queue"}
          onClick={() => setTab("queue")}
        >
          <Pill aria-hidden="true" />
          Dispense queue
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === "stock" ? "default" : "outline"}
          data-testid="pharmacy-tab-stock"
          aria-pressed={tab === "stock"}
          onClick={() => setTab("stock")}
        >
          <Boxes aria-hidden="true" />
          Stock
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="pharmacy-refresh"
          onClick={() => {
            void loadQueue();
            void loadStock();
            if (selectedRef.current) void loadDetail(selectedRef.current, false);
          }}
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {tab === "queue" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <aside className="space-y-3">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                data-testid="pharmacy-search"
                aria-label="Search the dispense queue"
                placeholder="MRN, name, visit or medicine"
                value={queueSearch}
                onChange={(event) => setQueueSearch(event.target.value)}
                className="pl-7"
              />
            </div>

            <div data-testid="pharmacy-queue" className="space-y-2">
              {queueLoading ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  Loading the dispense queue…
                </p>
              ) : prescriptions.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  No prescriptions are waiting to be dispensed.
                </p>
              ) : (
                prescriptions.map((entry) => (
                  <button
                    key={entry.prescriptionId}
                    type="button"
                    data-testid={`pharmacy-prescription-${entry.prescriptionId}`}
                    onClick={() => selectPrescription(entry)}
                    aria-pressed={selectedId === entry.prescriptionId}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                      selectedId === entry.prescriptionId
                        ? "border-primary bg-secondary/50"
                        : "border-border bg-card hover:bg-secondary/30",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{entry.patientName}</span>
                      <Badge variant="outline" className={STATUS_STYLES[entry.status]}>
                        {entry.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {entry.mrn} · {entry.encounterNo}
                    </p>
                    <p className="mt-1 truncate text-[11px] font-medium">
                      {rxDisplayName(entry)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {entry.remaining} of {entry.quantity} {entry.unit} remaining ·{" "}
                      {entry.availableStock} in stock
                    </p>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="min-w-0">
            {detail ? (
              <div className="space-y-4">
                <div data-testid="pharmacy-patient-banner" className={cn(CARD_CLASS, "px-4 py-3")}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <UserRound aria-hidden="true" className="size-4 text-primary" />
                        <p className="truncate text-base font-semibold">
                          {detail.prescription.patientName}
                        </p>
                        <Badge
                          variant="outline"
                          data-testid="pharmacy-status"
                          className={STATUS_STYLES[detail.prescription.status]}
                        >
                          {detail.prescription.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {detail.prescription.mrn} · {detail.prescription.sex} ·{" "}
                        {patientAge(detail.prescription.dob)} · {detail.prescription.encounterNo}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 rounded-md border border-border px-3 py-2">
                    <p className="text-sm font-medium">{rxDisplayName(detail.prescription)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {detail.prescription.dose} · {detail.prescription.route} ·{" "}
                      {detail.prescription.frequency}
                      {detail.prescription.durationDays
                        ? ` · ${detail.prescription.durationDays} days`
                        : ""}{" "}
                      · qty {detail.prescription.quantity}
                    </p>
                    {detail.prescription.instructions ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {detail.prescription.instructions}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>Dispensed: {detail.prescription.dispensedQuantity}</span>
                      <span>Remaining: {detail.prescription.remaining}</span>
                      <span>In stock: {detail.prescription.availableStock}</span>
                    </div>
                  </div>
                </div>

                {canDispensePrescription(detail.prescription.status as never) ? (
                  <div data-testid="dispense-panel" className={cn(CARD_CLASS, "px-4 py-3")}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className={SECTION_TITLE_CLASS}>Dispense</h2>
                      <span className="text-[11px] text-muted-foreground">
                        FEFO — first expiry, first out
                      </span>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                      <div>
                        <Label htmlFor="dispense-quantity">Quantity</Label>
                        <Input
                          id="dispense-quantity"
                          data-testid="dispense-quantity"
                          type="number"
                          min={1}
                          max={detail.prescription.remaining}
                          inputMode="numeric"
                          value={dispenseQuantity}
                          onChange={(event) => setDispenseQuantity(event.target.value)}
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="dispense-note">Note (optional)</Label>
                        <Input
                          id="dispense-note"
                          data-testid="dispense-note"
                          value={dispenseNote}
                          onChange={(event) => setDispenseNote(event.target.value)}
                          placeholder="Counselling note or substitution"
                          className="mt-1"
                        />
                      </div>
                    </div>

                    <div className="mt-3" data-testid="fefo-plan">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        Suggested batches ({planTotal} of{" "}
                        {toNumber(dispenseQuantity) ?? 0} covered)
                      </p>
                      {plan.length === 0 ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          No usable batches in stock for this medicine.
                        </p>
                      ) : (
                        <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                          {plan.map((entry) => (
                            <li
                              key={entry.batch.id}
                              className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]"
                            >
                              <span className="font-mono font-medium">{entry.batch.batchNo}</span>
                              <span className="text-muted-foreground">
                                exp {formatDate(entry.batch.expiryDate)}
                              </span>
                              <span className="tabular-nums">
                                take {entry.quantity} (of {entry.batch.available})
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] text-muted-foreground">
                        Partial quantities are allowed — dispense what is on hand.
                      </p>
                      <Button
                        type="button"
                        data-testid="dispense-submit"
                        disabled={busy === `dispense:${detail.prescription.prescriptionId}`}
                        onClick={() => void dispense()}
                      >
                        <Pill aria-hidden="true" />
                        Dispense
                      </Button>
                    </div>
                  </div>
                ) : null}

                {lastLabel ? (
                  <div data-testid="dispense-label" className={cn(CARD_CLASS, "px-4 py-3")}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className={SECTION_TITLE_CLASS}>Label ready</h2>
                      <Button type="button" size="sm" variant="outline" onClick={printLabel}>
                        <Printer aria-hidden="true" />
                        Print label
                      </Button>
                    </div>
                    <div className="mt-3 rounded-md border border-dashed border-border px-3 py-3">
                      <p className="text-sm font-semibold text-primary">{lastLabel.facilityName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {lastLabel.patientName} · {lastLabel.mrn} · {lastLabel.encounterNo}
                      </p>
                      <p className="mt-2 text-sm font-medium">{lastLabel.itemName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {lastLabel.strength ? `${lastLabel.strength} · ` : ""}
                        {lastLabel.form ?? ""}
                      </p>
                      <p className="mt-2 text-xs">
                        Take {lastLabel.dose} {lastLabel.route} · {lastLabel.frequency}
                        {lastLabel.durationDays ? ` · ${lastLabel.durationDays} days` : ""}
                      </p>
                      <p className="text-xs">
                        Quantity dispensed: {lastLabel.quantity} {lastLabel.unit}
                      </p>
                      {lastLabel.instructions ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {lastLabel.instructions}
                        </p>
                      ) : null}
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        Dispensed {formatDateTime(lastLabel.dispensedAt)}
                      </p>
                    </div>
                  </div>
                ) : null}

                {detail.dispenses.length > 0 ? (
                  <div className={cn(CARD_CLASS, "px-4 py-3")} data-testid="dispense-history">
                    <h2 className={SECTION_TITLE_CLASS}>Dispense history</h2>
                    <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                      {detail.dispenses.map((entry: DispenseRecord) => (
                        <li
                          key={entry.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]"
                        >
                          <span className="font-mono font-medium">{entry.batchNo}</span>
                          <span className="text-muted-foreground">
                            {formatDateTime(entry.createdAt)}
                          </span>
                          <span className="tabular-nums">×{entry.quantity}</span>
                          {entry.reversedAt ? (
                            <Badge variant="outline" className="border-border bg-muted">
                              reversed
                            </Badge>
                          ) : (
                            <CheckCircle2 aria-hidden="true" className="size-3.5 text-primary" />
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {canReverseDispense(detail.prescription.status as never) ? (
                  <div className={cn(CARD_CLASS, "px-4 py-3")} data-testid="reverse-panel">
                    <h2 className={SECTION_TITLE_CLASS}>Reverse the last dispense</h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Returns every dispensed unit to stock and reopens the prescription.
                    </p>
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Label htmlFor="reverse-note">Reason</Label>
                        <Input
                          id="reverse-note"
                          data-testid="reverse-note"
                          value={reverseNote}
                          onChange={(event) => setReverseNote(event.target.value)}
                          placeholder="Wrong medicine, patient declined…"
                          className="mt-1"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        data-testid="reverse-submit"
                        disabled={busy === `reverse:${detail.prescription.prescriptionId}`}
                        onClick={() => void reverse()}
                      >
                        <RotateCcw aria-hidden="true" />
                        Reverse
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid h-full min-h-64 place-items-center rounded-lg border border-dashed border-border px-6 py-12 text-center">
                <div>
                  <Pill aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">Select a prescription to dispense</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The pharmacy suggests FEFO batches, supports partial dispense and prints a label.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="space-y-4">
          <div className={cn(CARD_CLASS, "px-4 py-3")}>
            <div className="flex flex-wrap items-end gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  data-testid="stock-search"
                  aria-label="Search stock"
                  placeholder="Item, code or batch"
                  value={stockSearch}
                  onChange={(event) => setStockSearch(event.target.value)}
                  className="pl-7"
                />
              </div>
              <div className="w-48">
                <select
                  aria-label="Filter by store"
                  data-testid="stock-store"
                  className={SELECT_CLASS}
                  value={stockStoreId}
                  onChange={(event) => setStockStoreId(event.target.value)}
                >
                  <option value="">All stores</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className={cn(CARD_CLASS, "px-4 py-3")} data-testid="stock-list">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={SECTION_TITLE_CLASS}>Batch stock</h2>
              <span className="text-[11px] text-muted-foreground">
                {stock.length} batch{stock.length === 1 ? "" : "es"} on hand · click a row to adjust
                or transfer
              </span>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[11px] text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-1.5 pr-2 font-medium">Item</th>
                    <th className="py-1.5 pr-2 font-medium">Batch</th>
                    <th className="py-1.5 pr-2 font-medium">Expiry</th>
                    <th className="py-1.5 pr-2 font-medium">Store</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((row) => (
                    <tr
                      key={`${row.batchId}:${row.storeId}`}
                      data-testid={`stock-row-${row.batchId}`}
                      onClick={() => {
                        setSelectedBatchId(row.batchId);
                        setTransferForm((current) => ({ ...current, toStoreId: "" }));
                      }}
                      className={cn(
                        "cursor-pointer border-b border-border/60 transition-colors",
                        selectedBatchId === row.batchId
                          ? "bg-secondary/50"
                          : "hover:bg-secondary/30",
                      )}
                    >
                      <td className="py-1.5 pr-2">
                        <span className="font-medium">{row.itemName}</span>
                        {row.strength ? (
                          <span className="ml-1 text-muted-foreground">{row.strength}</span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2 font-mono">{row.batchNo}</td>
                      <td className="py-1.5 pr-2">
                        {row.expired ? (
                          <span className="inline-flex items-center gap-1 text-[var(--status-critical-foreground)]">
                            <AlertTriangle aria-hidden="true" className="size-3" />
                            {formatDate(row.expiryDate)}
                          </span>
                        ) : (
                          formatDate(row.expiryDate)
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-muted-foreground">{row.storeName}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.quantity}</td>
                    </tr>
                  ))}
                  {stock.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-muted-foreground">
                        No stock matches this filter.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className={cn(CARD_CLASS, "px-4 py-3")} data-testid="receive-panel">
              <div className="flex items-center gap-2">
                <PackagePlus aria-hidden="true" className="size-4 text-primary" />
                <h2 className={SECTION_TITLE_CLASS}>Receive stock</h2>
              </div>
              <div className="mt-3 space-y-2">
                <div>
                  <Label htmlFor="receive-item-search">Item</Label>
                  <Input
                    id="receive-item-search"
                    data-testid="receive-item-search"
                    placeholder="Search medicines"
                    value={itemSearch}
                    onChange={(event) => setItemSearch(event.target.value)}
                    className="mt-1"
                  />
                  <select
                    aria-label="Item"
                    data-testid="receive-item"
                    className={cn(SELECT_CLASS, "mt-1")}
                    value={receiveForm.itemId}
                    onChange={(event) =>
                      setReceiveForm((current) => ({ ...current, itemId: event.target.value }))
                    }
                  >
                    <option value="">Choose an item</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {itemDisplayName(item)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="receive-batch">Batch no.</Label>
                    <Input
                      id="receive-batch"
                      data-testid="receive-batch"
                      value={receiveForm.batchNo}
                      onChange={(event) =>
                        setReceiveForm((current) => ({ ...current, batchNo: event.target.value }))
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="receive-expiry">Expiry</Label>
                    <Input
                      id="receive-expiry"
                      data-testid="receive-expiry"
                      type="date"
                      value={receiveForm.expiryDate}
                      onChange={(event) =>
                        setReceiveForm((current) => ({ ...current, expiryDate: event.target.value }))
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="receive-quantity">Quantity</Label>
                    <Input
                      id="receive-quantity"
                      data-testid="receive-quantity"
                      type="number"
                      min={1}
                      value={receiveForm.quantity}
                      onChange={(event) =>
                        setReceiveForm((current) => ({ ...current, quantity: event.target.value }))
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="receive-cost">Unit cost</Label>
                    <Input
                      id="receive-cost"
                      data-testid="receive-cost"
                      type="number"
                      min={0}
                      step="0.01"
                      value={receiveForm.unitCost}
                      onChange={(event) =>
                        setReceiveForm((current) => ({ ...current, unitCost: event.target.value }))
                      }
                      className="mt-1"
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  data-testid="receive-submit"
                  disabled={busy === "receive"}
                  onClick={() => void receive()}
                >
                  <PackagePlus aria-hidden="true" />
                  Receive
                </Button>
              </div>
            </div>

            <div className={cn(CARD_CLASS, "px-4 py-3")} data-testid="adjust-panel">
              <div className="flex items-center gap-2">
                <SlidersHorizontal aria-hidden="true" className="size-4 text-primary" />
                <h2 className={SECTION_TITLE_CLASS}>Adjust stock</h2>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {selectedBatch
                  ? `${selectedBatch.itemName} · batch ${selectedBatch.batchNo} · ${selectedBatch.quantity} on hand`
                  : "Select a batch from the stock list above."}
              </p>
              <div className="mt-3 space-y-2">
                <div>
                  <Label htmlFor="adjust-qty">Change (use − for loss)</Label>
                  <Input
                    id="adjust-qty"
                    data-testid="adjust-qty"
                    type="number"
                    value={adjustForm.qtyDelta}
                    onChange={(event) =>
                      setAdjustForm((current) => ({ ...current, qtyDelta: event.target.value }))
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="adjust-note">Reason</Label>
                  <Input
                    id="adjust-note"
                    data-testid="adjust-note"
                    value={adjustForm.note}
                    onChange={(event) =>
                      setAdjustForm((current) => ({ ...current, note: event.target.value }))
                    }
                    placeholder="Breakage, count correction…"
                    className="mt-1"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="adjust-submit"
                  disabled={busy === `adjust:${selectedBatchId}` || !selectedBatch}
                  onClick={() => void adjust()}
                >
                  <SlidersHorizontal aria-hidden="true" />
                  Adjust
                </Button>
              </div>
            </div>

            <div className={cn(CARD_CLASS, "px-4 py-3")} data-testid="transfer-panel">
              <div className="flex items-center gap-2">
                <ArrowLeftRight aria-hidden="true" className="size-4 text-primary" />
                <h2 className={SECTION_TITLE_CLASS}>Transfer stock</h2>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {selectedBatch
                  ? `From ${selectedBatch.storeName} · ${selectedBatch.quantity} on hand`
                  : "Select a batch from the stock list above."}
              </p>
              <div className="mt-3 space-y-2">
                <div>
                  <Label htmlFor="transfer-to">Destination store</Label>
                  <select
                    id="transfer-to"
                    data-testid="transfer-to"
                    className={cn(SELECT_CLASS, "mt-1")}
                    value={transferForm.toStoreId}
                    onChange={(event) =>
                      setTransferForm((current) => ({ ...current, toStoreId: event.target.value }))
                    }
                  >
                    <option value="">Choose a store</option>
                    {stores
                      .filter((store) => store.id !== selectedBatch?.storeId)
                      .map((store) => (
                        <option key={store.id} value={store.id}>
                          {store.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="transfer-quantity">Quantity</Label>
                  <Input
                    id="transfer-quantity"
                    data-testid="transfer-quantity"
                    type="number"
                    min={1}
                    value={transferForm.quantity}
                    onChange={(event) =>
                      setTransferForm((current) => ({ ...current, quantity: event.target.value }))
                    }
                    className="mt-1"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="transfer-submit"
                  disabled={busy === `transfer:${selectedBatchId}` || !selectedBatch}
                  onClick={() => void transfer()}
                >
                  <ArrowLeftRight aria-hidden="true" />
                  Transfer
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
