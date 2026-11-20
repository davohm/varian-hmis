"use client";

import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  CreditCard,
  FileText,
  Printer,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Split,
  Wallet,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  INVOICE_STATUS_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  toCents,
  type InvoiceStatus,
  type PaymentMethod,
} from "@/lib/billing";
import { ageFromDob } from "@/lib/triage";
import type {
  BillPaymentView,
  CashierQueueItem,
  CashierSessionView,
  EncounterBill,
  EndOfDayReport,
  ReceiptView,
} from "@/server/queries/billing";
import { cn } from "cn";

const CARD_CLASS = "rounded-lg border border-border bg-card";
const SECTION_TITLE_CLASS = "text-sm font-semibold";
const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30";

const STATUS_STYLES: Record<string, string> = {
  open: "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  partial:
    "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]",
  paid: "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]",
  void: "border-border bg-muted text-muted-foreground",
};

type Tab = "register" | "sessions";

interface TenderRow {
  method: PaymentMethod;
  amount: string;
  reference: string;
}

interface ReceiptRecord {
  receipt: ReceiptView;
  text: string;
}

class SessionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMismatchError";
  }
}

class ChartAccessRequiredError extends Error {
  code = "chart_access_reason_required" as const;
  privacy?: EncounterBill["privacy"];

  constructor(message: string, privacy?: EncounterBill["privacy"]) {
    super(message);
    this.name = "ChartAccessRequiredError";
    this.privacy = privacy;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
      detail?: string;
      issues?: Array<{ message?: string }>;
      code?: string;
      privacy?: EncounterBill["privacy"];
    } | null;
    const message =
      detail?.issues?.[0]?.message ??
      detail?.detail ??
      detail?.error ??
      `Request failed (${response.status})`;
    if (response.status === 403 && detail?.code === "chart_access_reason_required") {
      throw new ChartAccessRequiredError(message, detail?.privacy);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SessionMismatchError(message);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "cashier-station" },
    body: JSON.stringify(body),
  });
}

async function handleSessionMismatch(error: unknown): Promise<boolean> {
  if (!(error instanceof SessionMismatchError)) return false;
  toast.error("Your session changed. Returning to your workspace.");
  window.location.assign("/");
  return true;
}

function money(value: string | number | null | undefined): string {
  if (value == null || value === "") return "KSh 0.00";
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return `KSh ${String(value)}`;
  return `KSh ${amount.toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function patientAge(dob: string | null): string {
  const age = ageFromDob(dob);
  return age == null ? "Age unknown" : `${age} yrs`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isReversed(payment: BillPaymentView, payments: BillPaymentView[]): boolean {
  return payments.some((row) => row.reversedPaymentId === payment.id);
}

export function CashierWorkspace() {
  const [tab, setTab] = useState<Tab>("register");
  const [busy, setBusy] = useState<string | null>(null);

  /* Register ---------------------------------------------------------- */

  const [queue, setQueue] = useState<CashierQueueItem[]>([]);
  const [queueSearch, setQueueSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [queueLoading, setQueueLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bill, setBill] = useState<EncounterBill | null>(null);
  const [restrictedAccess, setRestrictedAccess] = useState<{
    encounterId: string;
    message: string;
    privacy?: EncounterBill["privacy"];
  } | null>(null);
  const [accessReason, setAccessReason] = useState("");
  const [tenders, setTenders] = useState<TenderRow[]>([
    { method: "cash", amount: "", reference: "" },
  ]);
  const [paymentNote, setPaymentNote] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [reverseTargetId, setReverseTargetId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);

  /* Sessions ---------------------------------------------------------- */

  const [session, setSession] = useState<CashierSessionView | null>(null);
  const [recentSessions, setRecentSessions] = useState<CashierSessionView[]>([]);
  const [sessionFloat, setSessionFloat] = useState("0");
  const [countedCash, setCountedCash] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [report, setReport] = useState<EndOfDayReport | null>(null);
  const [reportSessionId, setReportSessionId] = useState<string | null>(null);

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
    const timer = setTimeout(() => setDebouncedSearch(queueSearch), 250);
    return () => clearTimeout(timer);
  }, [queueSearch]);

  const loadQueue = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      const data = await requestJson<{ queue: CashierQueueItem[] }>(
        `/api/cashier/queue?${params.toString()}`,
      );
      setQueue(data.queue);
    } catch {
      // A transient queue failure should not clear the register.
    } finally {
      setQueueLoading(false);
    }
  }, [debouncedSearch]);

  const loadBill = useCallback(async (encounterId: string, reason?: string) => {
    try {
      const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
      const data = await requestJson<EncounterBill>(
        `/api/cashier/encounters/${encounterId}${query}`,
      );
      setBill(data);
      setRestrictedAccess(null);
      setAccessReason("");
    } catch (error) {
      if (error instanceof ChartAccessRequiredError) {
        setBill(null);
        setRestrictedAccess({
          encounterId,
          message: error.message,
          privacy: error.privacy,
        });
        setAccessReason("");
        return;
      }
      if (await handleSessionMismatch(error)) return;
      setBill(null);
      setRestrictedAccess(null);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await requestJson<{
        current: CashierSessionView | null;
        recent: CashierSessionView[];
      }>("/api/cashier/sessions");
      setSession(data.current);
      setRecentSessions(data.recent);
    } catch {
      // Keep the last known session state.
    }
  }, []);

  const loadReport = useCallback(async (sessionId: string) => {
    try {
      const data = await requestJson<EndOfDayReport>(
        `/api/cashier/sessions/report?sessionId=${sessionId}`,
      );
      setReport(data);
      setReportSessionId(sessionId);
    } catch {
      setReport(null);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
    void loadSessions();
    const interval = setInterval(() => {
      void loadQueue();
      void loadSessions();
    }, 30_000);
    const source = new EventSource("/api/events");
    const onBill = () => {
      void loadQueue();
      void loadSessions();
      const current = selectedRef.current;
      if (current) void loadBill(current);
    };
    const queueEvents = [
      "charge_synced",
      "invoice_opened",
      "invoice_voided",
      "payment_received",
      "payment_reversed",
      "cashier_session_opened",
      "cashier_session_closed",
      "encounter_closed",
      "queue_changed",
      "consultation_started",
      "lab_order_created",
      "lab_order_cancelled",
      "prescription_dispensed",
      "prescription_reversed",
      "prescription_cancelled",
    ];
    for (const event of queueEvents) source.addEventListener(event, onBill);
    return () => {
      clearInterval(interval);
      for (const event of queueEvents) source.removeEventListener(event, onBill);
      source.close();
    };
  }, [loadQueue, loadSessions, loadBill]);

  // Default the first tender to the outstanding balance whenever a bill loads.
  useEffect(() => {
    if (!bill) return;
    const outstanding = bill.outstanding;
    setTenders((current) => {
      if (current.length !== 1) return current;
      if (current[0].amount.trim() !== "") return current;
      return [{ ...current[0], amount: outstanding === "0.00" ? "" : outstanding }];
    });
  }, [bill]);

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

  function selectEncounter(entry: CashierQueueItem): void {
    setSelectedId(entry.encounterId);
    selectedRef.current = entry.encounterId;
    setReceipts([]);
    setVoidReason("");
    setReverseTargetId(null);
    setReverseReason("");
    setPaymentNote("");
    setTenders([{ method: "cash", amount: "", reference: "" }]);
    setRestrictedAccess(null);
    setAccessReason("");
    void loadBill(entry.encounterId);
  }

  async function refreshAfterChange(encounterId: string): Promise<void> {
    await Promise.all([loadBill(encounterId), loadQueue(), loadSessions()]);
  }

  async function openSession(): Promise<void> {
    const openingFloat = Number(sessionFloat);
    if (!Number.isFinite(openingFloat) || openingFloat < 0) {
      toast.error("Enter a valid opening float");
      return;
    }
    const scope = "session-open";
    const ok = await runAction(
      scope,
      scope,
      () =>
        postJson<{ sessionId: string }>("/api/cashier/sessions", {
          openingFloat,
          idempotencyKey: keyFor(scope),
        }),
      "Cashier session open",
    );
    if (ok) {
      await loadSessions();
      setCountedCash("");
      setCloseNote("");
    }
  }

  async function closeSession(): Promise<void> {
    if (!session) return;
    const counted = Number(countedCash);
    if (!Number.isFinite(counted) || counted < 0) {
      toast.error("Enter the counted cash");
      return;
    }
    const scope = `session-close:${session.sessionId}`;
    const ok = await runAction(
      scope,
      scope,
      () =>
        postJson<{ sessionId: string }>("/api/cashier/sessions/close", {
          sessionId: session.sessionId,
          countedCash: counted,
          note: closeNote.trim() || null,
          idempotencyKey: keyFor(scope),
        }),
      "Cashier session closed",
    );
    if (ok) {
      await loadSessions();
      await loadReport(session.sessionId);
      setTab("sessions");
    }
  }

  async function openInvoice(): Promise<void> {
    if (!bill) return;
    const scope = `invoice:${bill.encounterId}`;
    const ok = await runAction(
      scope,
      scope,
      () =>
        postJson<{ invoiceId: string }>("/api/cashier/invoices", {
          encounterId: bill.encounterId,
          idempotencyKey: keyFor(scope),
        }),
      "Invoice opened",
    );
    if (ok) await refreshAfterChange(bill.encounterId);
  }

  async function voidInvoice(): Promise<void> {
    if (!bill?.invoice) return;
    if (voidReason.trim().length === 0) {
      toast.error("Enter a reason before voiding the invoice");
      return;
    }
    const scope = `void:${bill.invoice.id}`;
    const ok = await runAction(
      scope,
      scope,
      () =>
        postJson<{ invoiceId: string }>("/api/cashier/invoices/void", {
          invoiceId: bill.invoice!.id,
          reason: voidReason.trim(),
          idempotencyKey: keyFor(scope),
        }),
      "Invoice voided",
    );
    if (ok) {
      setVoidReason("");
      setReceipts([]);
      await refreshAfterChange(bill.encounterId);
    }
  }

  function updateTender(index: number, patch: Partial<TenderRow>): void {
    setTenders((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  }

  function addTender(): void {
    setTenders((current) => {
      if (current.length >= 5) {
        toast.error("A payment can carry at most five tenders");
        return current;
      }
      return [...current, { method: "cash", amount: "", reference: "" }];
    });
  }

  function removeTender(index: number): void {
    setTenders((current) =>
      current.length === 1 ? current : current.filter((_, position) => position !== index),
    );
  }

  async function takePayment(): Promise<void> {
    if (!bill?.invoice) {
      toast.error("Open an invoice before taking payment");
      return;
    }
    if (!session) {
      toast.error("Open a cashier session before taking payments");
      return;
    }
    const rows = tenders
      .map((row) => ({ ...row, amount: row.amount.trim() }))
      .filter((row) => row.amount !== "");
    if (rows.length === 0) {
      toast.error("Add at least one tender");
      return;
    }
    for (const row of rows) {
      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error("Tender amounts must be greater than zero");
        return;
      }
    }
    const tenderTotal = rows.reduce((total, row) => total + toCents(row.amount), 0);
    if (tenderTotal > toCents(bill.outstanding)) {
      toast.error(`The tenders exceed the balance of ${money(bill.outstanding)}`);
      return;
    }

    const scope = `payment:${bill.invoice.id}`;
    let created: Array<{ paymentId: string }> = [];
    const ok = await runAction(
      scope,
      scope,
      async () => {
        const result = await postJson<{ payments: Array<{ paymentId: string }> }>(
          "/api/cashier/payments",
          {
            invoiceId: bill.invoice!.id,
            tenders: rows.map((row) => ({
              method: row.method,
              amount: Number(row.amount),
              reference: row.reference.trim() || null,
            })),
            note: paymentNote.trim() || null,
            idempotencyKey: keyFor(scope),
          },
        );
        created = result.payments;
        return result;
      },
      rows.length > 1 ? "Split payment recorded" : "Payment recorded",
    );
    if (!ok) return;

    const loaded = await Promise.all(
      created.map((payment) =>
        requestJson<ReceiptRecord>(`/api/cashier/receipts/${payment.paymentId}`).catch(
          () => null,
        ),
      ),
    );
    setReceipts(loaded.filter((entry): entry is ReceiptRecord => entry != null));
    setTenders([{ method: "cash", amount: "", reference: "" }]);
    setPaymentNote("");
    await refreshAfterChange(bill.encounterId);
  }

  async function reversePayment(): Promise<void> {
    if (!bill || !reverseTargetId) return;
    if (reverseReason.trim().length === 0) {
      toast.error("Enter a reason before reversing the payment");
      return;
    }
    const scope = `reverse:${reverseTargetId}`;
    const ok = await runAction(
      scope,
      scope,
      () =>
        postJson<{ reversalPaymentId: string }>("/api/cashier/payments/reverse", {
          paymentId: reverseTargetId,
          reason: reverseReason.trim(),
          idempotencyKey: keyFor(scope),
        }),
      "Payment reversed",
    );
    if (ok) {
      setReverseTargetId(null);
      setReverseReason("");
      setReceipts([]);
      await refreshAfterChange(bill.encounterId);
    }
  }

  function printReceipt(text: string): void {
    const popup = window.open("", "_blank", "width=420,height=700");
    if (!popup) {
      toast.error("Allow pop-ups to print the receipt");
      return;
    }
    popup.document.write(
      `<!doctype html><html><head><title>Receipt</title><style>
        @page { size: 80mm auto; margin: 0; }
        html, body { margin: 0; padding: 0; background: #fff; }
        body { width: 72mm; margin: 0 auto; padding: 4mm 0; font-family: ui-monospace, "Cascadia Mono", "Courier New", monospace; font-size: 11px; line-height: 1.35; color: #000; }
        pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
      </style></head><body><pre>${escapeHtml(text)}</pre></body></html>`,
    );
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function printReport(): void {
    if (!report) return;
    const popup = window.open("", "_blank", "width=520,height=760");
    if (!popup) {
      toast.error("Allow pop-ups to print the report");
      return;
    }
    const rows = report.payments
      .map(
        (payment) =>
          `<tr><td>${escapeHtml(payment.receiptNo)}</td><td>${escapeHtml(payment.invoiceNo)}</td><td>${escapeHtml(payment.patientName)}</td><td>${escapeHtml(PAYMENT_METHOD_LABELS[payment.method])}</td><td style="text-align:right">${escapeHtml(money(payment.amount))}</td></tr>`,
      )
      .join("");
    popup.document.write(
      `<!doctype html><html><head><title>End of day</title><style>
        body{font-family:ui-sans-serif,system-ui,sans-serif;padding:24px;color:#022f5b}
        h1{font-size:18px;margin:0 0 4px}
        h2{font-size:14px;margin:20px 0 6px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}
        .muted{color:#666;font-size:12px}
        .totals{margin-top:12px;font-size:13px}
      </style></head><body>
        <h1>End of day</h1>
        <p class="muted">Session opened ${escapeHtml(formatDateTime(report.session.openedAt))}${report.session.closedAt ? ` - closed ${escapeHtml(formatDateTime(report.session.closedAt))}` : ""}</p>
        <div class="totals">
          <div>Opening float: ${escapeHtml(money(report.session.openingFloat))}</div>
          <div>Collected: ${escapeHtml(money(report.totalCollected))}</div>
          <div>Reversed: ${escapeHtml(money(report.totalReversed))}</div>
          <div>Cash expected: ${escapeHtml(money(report.cashExpected))}</div>
          <div>Counted cash: ${escapeHtml(money(report.session.countedCash))}</div>
          <div>Variance: ${escapeHtml(money(report.session.variance))}</div>
        </div>
        <h2>Receipts</h2>
        <table><thead><tr><th>Receipt</th><th>Invoice</th><th>Patient</th><th>Method</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      </body></html>`,
    );
    popup.document.close();
    popup.focus();
    popup.print();
  }

  const tenderTotal = tenders.reduce((total, row) => total + toCents(row.amount || "0"), 0);
  const outstandingCents = bill ? toCents(bill.outstanding) : 0;
  const canTakePayment =
    bill?.invoice != null &&
    session != null &&
    bill.invoice.status !== "void" &&
    outstandingCents > 0 &&
    tenderTotal > 0 &&
    tenderTotal <= outstandingCents;
  const activeCharges = bill?.charges.filter((charge) => !charge.voidedAt) ?? [];
  const paidCents = bill?.invoice ? toCents(bill.invoice.paid) : 0;
  const canVoidInvoice =
    bill?.invoice != null && bill.invoice.status !== "void" && paidCents === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Cashier view">
        <Button
          type="button"
          size="sm"
          variant={tab === "register" ? "default" : "outline"}
          data-testid="cashier-tab-register"
          aria-pressed={tab === "register"}
          onClick={() => setTab("register")}
        >
          <Receipt aria-hidden /> Register
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === "sessions" ? "default" : "outline"}
          data-testid="cashier-tab-sessions"
          aria-pressed={tab === "sessions"}
          onClick={() => setTab("sessions")}
        >
          <Wallet aria-hidden /> Sessions
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            data-testid="session-status"
            className={cn(
              session
                ? "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            {session ? `Session open ${formatDateTime(session.openedAt)}` : "No session open"}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="refresh-cashier"
            onClick={() => {
              void loadQueue();
              void loadSessions();
              const current = selectedRef.current;
              if (current) void loadBill(current);
            }}
          >
            <RefreshCw aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {!session ? (
        <section className={cn(CARD_CLASS, "p-4")}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="opening-float">Opening float</Label>
              <Input
                id="opening-float"
                data-testid="opening-float"
                type="number"
                min="0"
                step="0.01"
                value={sessionFloat}
                onChange={(event) => setSessionFloat(event.target.value)}
                className="w-40"
              />
            </div>
            <Button
              type="button"
              data-testid="open-session"
              disabled={busy != null}
              onClick={() => void openSession()}
            >
              <Wallet aria-hidden /> Open cashier session
            </Button>
            <p className="text-xs text-muted-foreground">
              A session is required before any payment can be taken.
            </p>
          </div>
        </section>
      ) : null}

      {tab === "register" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <section className={cn(CARD_CLASS, "flex min-h-[420px] flex-col")}>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search aria-hidden className="size-4 text-muted-foreground" />
              <Input
                aria-label="Search visits"
                data-testid="cashier-search"
                placeholder="MRN, name or visit number"
                value={queueSearch}
                onChange={(event) => setQueueSearch(event.target.value)}
                className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <div className="flex-1 overflow-y-auto" data-testid="cashier-queue">
              {queueLoading ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">Loading visits…</p>
              ) : queue.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">
                  Nothing to bill. Charges appear here as soon as a consultation, laboratory
                  test or dispense is recorded.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {queue.map((entry) => (
                    <li key={entry.encounterId}>
                      <button
                        type="button"
                        data-testid="cashier-queue-item"
                        onClick={() => selectEncounter(entry)}
                        className={cn(
                          "w-full px-3 py-3 text-left transition-colors hover:bg-accent",
                          selectedId === entry.encounterId && "bg-accent",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{entry.patientName}</span>
                          <span className="shrink-0 text-sm font-semibold">
                            {money(entry.outstanding)}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{entry.mrn}</span>
                          <span>·</span>
                          <span>{entry.encounterNo}</span>
                          <span>·</span>
                          <span>{patientAge(entry.dob)}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {entry.invoiceStatus ? (
                            <Badge
                              variant="outline"
                              className={STATUS_STYLES[entry.invoiceStatus] ?? ""}
                            >
                              {INVOICE_STATUS_LABELS[entry.invoiceStatus as InvoiceStatus] ??
                                entry.invoiceStatus}
                            </Badge>
                          ) : null}
                          {entry.unbilledCount > 0 ? (
                            <Badge
                              variant="outline"
                              className="border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]"
                            >
                              {entry.unbilledCount} unbilled
                            </Badge>
                          ) : null}
                          <Badge variant="outline" className="border-border bg-muted">
                            {entry.payerType}
                          </Badge>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <div className="space-y-4">
            {!bill ? (
              restrictedAccess?.encounterId === selectedId ? (
                <section className={cn(CARD_CLASS, "p-4")} data-testid="cashier-restricted-access">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold">Restricted chart access</h2>
                      <p className="mt-1 text-sm text-muted-foreground">{restrictedAccess.message}</p>
                    </div>
                    {(() => {
                      const privacy = restrictedAccess.privacy;
                      if (!privacy) return null;
                      const label =
                        privacy.consentStatus === "restricted"
                          ? "Consent: Restricted"
                          : privacy.consentStatus === "current"
                            ? "Consent: current"
                            : "Consent: missing";
                      const style =
                        privacy.consentStatus === "restricted"
                          ? "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
                          : privacy.consentStatus === "current"
                            ? "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                            : "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]";
                      return (
                        <Badge
                          variant="outline"
                          data-testid="cashier-consent-status"
                          className={cn("font-medium", style)}
                        >
                          {label}
                        </Badge>
                      );
                    })()}
                  </div>
                  <form
                    className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const reason = accessReason.trim();
                      if (!reason || !selectedId) return;
                      void loadBill(selectedId, reason);
                    }}
                  >
                    <div className="flex-1">
                      <Label htmlFor="cashier-access-reason">Reason for access</Label>
                      <Input
                        id="cashier-access-reason"
                        data-testid="cashier-access-reason"
                        value={accessReason}
                        onChange={(event) => setAccessReason(event.target.value)}
                        placeholder="e.g. Billing staff – payment processing"
                        required
                        autoComplete="off"
                      />
                    </div>
                    <Button type="submit" data-testid="cashier-access-reason-submit">
                      Continue
                    </Button>
                  </form>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Access to restricted charts is recorded with your reason.
                  </p>
                </section>
              ) : (
                <section className={cn(CARD_CLASS, "p-6")}>
                  <p className="text-sm text-muted-foreground">
                    Select a visit to review its charges, raise an invoice and take payment.
                  </p>
                </section>
              )
            ) : (
              <>
                <section className={cn(CARD_CLASS, "p-4")} data-testid="cashier-bill">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold">{bill.patientName}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {bill.mrn} · {bill.encounterNo} · {patientAge(bill.dob)} ·{" "}
                        {bill.payerType} payer
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Visit started {formatDate(bill.startedAt)}
                        {bill.encounterStatus !== "open" ? ` · ${bill.encounterStatus}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      {bill.invoice ? (
                        <>
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-sm font-medium">{bill.invoice.invoiceNo}</span>
                            <Badge
                              variant="outline"
                              className={STATUS_STYLES[bill.invoice.status] ?? ""}
                            >
                              {INVOICE_STATUS_LABELS[bill.invoice.status as InvoiceStatus] ??
                                bill.invoice.status}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Opened {formatDateTime(bill.invoice.createdAt)}
                          </p>
                        </>
                      ) : (
                        <Badge variant="outline" className="border-border bg-muted">
                          Not invoiced
                        </Badge>
                      )}
                      {bill.privacy ? (
                        <div className="mt-2 flex justify-end">
                          {(() => {
                            const { privacy } = bill;
                            const label =
                              privacy.consentStatus === "restricted"
                                ? "Consent: Restricted"
                                : privacy.consentStatus === "current"
                                  ? "Consent: current"
                                  : "Consent: missing";
                            const style =
                              privacy.consentStatus === "restricted"
                                ? "border-[var(--status-critical)] bg-[var(--status-critical-background)] text-[var(--status-critical-foreground)]"
                                : privacy.consentStatus === "current"
                                  ? "border-[var(--status-normal)] bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                                  : "border-[var(--status-warning)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]";
                            return (
                              <Badge
                                variant="outline"
                                data-testid="cashier-consent-status"
                                className={cn("font-medium", style)}
                              >
                                {label}
                              </Badge>
                            );
                          })()}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-2 font-medium">Description</th>
                          <th className="py-2 pr-2 text-right font-medium">Qty</th>
                          <th className="py-2 pr-2 text-right font-medium">Unit</th>
                          <th className="py-2 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bill.charges.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-4 text-center text-muted-foreground">
                              No charges recorded yet.
                            </td>
                          </tr>
                        ) : (
                          bill.charges.map((charge) => (
                            <tr
                              key={charge.id}
                              className={cn(
                                "border-b border-border/60 last:border-0",
                                charge.voidedAt && "text-muted-foreground line-through",
                              )}
                            >
                              <td className="py-2 pr-2">
                                {charge.description}
                                {charge.voidedAt ? " (void)" : ""}
                              </td>
                              <td className="py-2 pr-2 text-right">{charge.quantity}</td>
                              <td className="py-2 pr-2 text-right">{money(charge.unitPrice)}</td>
                              <td className="py-2 text-right font-medium">
                                {money(charge.amount)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Total</dt>
                      <dd className="font-semibold">{money(bill.invoice?.total ?? bill.unbilledTotal)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Paid</dt>
                      <dd className="font-semibold">{money(bill.invoice?.paid ?? "0")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Balance</dt>
                      <dd className="font-semibold">{money(bill.outstanding)}</dd>
                    </div>
                  </dl>

                  <div className="mt-4 flex flex-wrap items-end gap-2">
                    {bill.invoice == null || bill.unbilledTotal !== "0.00" ? (
                      <Button
                        type="button"
                        data-testid="open-invoice"
                        disabled={busy != null || activeCharges.length === 0}
                        onClick={() => void openInvoice()}
                      >
                        <FileText aria-hidden />
                        {bill.invoice ? "Add charges to invoice" : "Open invoice"}
                      </Button>
                    ) : null}
                    {canVoidInvoice ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="void-reason" className="text-xs">
                            Void reason
                          </Label>
                          <Input
                            id="void-reason"
                            data-testid="void-reason"
                            value={voidReason}
                            onChange={(event) => setVoidReason(event.target.value)}
                            className="h-8 w-56"
                            placeholder="Why is this invoice void?"
                          />
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="void-invoice"
                          disabled={busy != null}
                          onClick={() => void voidInvoice()}
                        >
                          <XCircle aria-hidden /> Void invoice
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </section>

                {bill.invoice && bill.invoice.status !== "void" && outstandingCents > 0 ? (
                  <section className={cn(CARD_CLASS, "p-4")} data-testid="payment-panel">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className={SECTION_TITLE_CLASS}>
                        <Split aria-hidden className="mr-1 inline size-4" />
                        Split tender
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        Balance {money(bill.outstanding)}
                      </span>
                    </div>
                    {!session ? (
                      <p className="mt-2 text-xs text-[var(--status-warning-foreground)]">
                        Open a cashier session above to take payment.
                      </p>
                    ) : null}
                    <div className="mt-3 space-y-2">
                      {tenders.map((tender, index) => (
                        <div key={index} className="flex flex-wrap items-end gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs" htmlFor={`tender-method-${index}`}>
                              Method
                            </Label>
                            <select
                              id={`tender-method-${index}`}
                              aria-label={`Tender ${index + 1} method`}
                              data-testid={`tender-method-${index}`}
                              className={cn(SELECT_CLASS, "w-36")}
                              value={tender.method}
                              onChange={(event) =>
                                updateTender(index, {
                                  method: event.target.value as PaymentMethod,
                                })
                              }
                            >
                              {PAYMENT_METHODS.map((method) => (
                                <option key={method} value={method}>
                                  {PAYMENT_METHOD_LABELS[method]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs" htmlFor={`tender-amount-${index}`}>
                              Amount
                            </Label>
                            <Input
                              id={`tender-amount-${index}`}
                              data-testid={`tender-amount-${index}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={tender.amount}
                              onChange={(event) =>
                                updateTender(index, { amount: event.target.value })
                              }
                              className="h-8 w-32"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs" htmlFor={`tender-reference-${index}`}>
                              Reference
                            </Label>
                            <Input
                              id={`tender-reference-${index}`}
                              data-testid={`tender-reference-${index}`}
                              value={tender.reference}
                              onChange={(event) =>
                                updateTender(index, { reference: event.target.value })
                              }
                              className="h-8 w-44"
                              placeholder="M-Pesa or card code"
                            />
                          </div>
                          {tenders.length > 1 ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-label={`Remove tender ${index + 1}`}
                              onClick={() => removeTender(index)}
                            >
                              <XCircle aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="add-tender"
                        onClick={addTender}
                      >
                        <Split aria-hidden /> Add tender
                      </Button>
                      <div className="ml-auto flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor="payment-note">
                            Note
                          </Label>
                          <Input
                            id="payment-note"
                            data-testid="payment-note"
                            value={paymentNote}
                            onChange={(event) => setPaymentNote(event.target.value)}
                            className="h-8 w-44"
                            placeholder="Optional"
                          />
                        </div>
                        <Button
                          type="button"
                          data-testid="take-payment"
                          disabled={busy != null || !canTakePayment}
                          onClick={() => void takePayment()}
                        >
                          <Banknote aria-hidden /> Take payment
                        </Button>
                      </div>
                    </div>
                  </section>
                ) : null}

                {receipts.length > 0 ? (
                  <section className={cn(CARD_CLASS, "p-4")} data-testid="payment-receipts">
                    <h3 className={SECTION_TITLE_CLASS}>
                      <CheckCircle2 aria-hidden className="mr-1 inline size-4" />
                      Receipts
                    </h3>
                    <div className="mt-3 space-y-3">
                      {receipts.map(({ receipt, text }) => (
                        <article
                          key={receipt.paymentId}
                          data-testid="payment-receipt"
                          className="rounded-lg border border-dashed border-border bg-background p-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-semibold">{receipt.receiptNo}</p>
                              <p className="text-xs text-muted-foreground">
                                {receipt.invoiceNo} · {receipt.patientName} · {receipt.mrn}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-semibold">{money(receipt.payment.amount)}</p>
                              <p className="text-xs text-muted-foreground">
                                {PAYMENT_METHOD_LABELS[receipt.payment.method as PaymentMethod] ??
                                  receipt.payment.method}
                                {receipt.isReversal ? " · reversal" : ""}
                              </p>
                            </div>
                          </div>
                          <pre className="mt-3 max-h-64 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-tight">
                            {text}
                          </pre>
                          <div className="mt-2 flex justify-end">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              data-testid="print-receipt"
                              onClick={() => printReceipt(text)}
                            >
                              <Printer aria-hidden /> Print 80 mm receipt
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className={cn(CARD_CLASS, "p-4")} data-testid="payment-ledger">
                  <h3 className={SECTION_TITLE_CLASS}>
                    <ShieldCheck aria-hidden className="mr-1 inline size-4" />
                    Payment ledger
                  </h3>
                  {bill.payments.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No payments recorded.</p>
                  ) : (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="py-2 pr-2 font-medium">Receipt</th>
                            <th className="py-2 pr-2 font-medium">Method</th>
                            <th className="py-2 pr-2 font-medium">Received</th>
                            <th className="py-2 pr-2 text-right font-medium">Amount</th>
                            <th className="py-2 text-right font-medium">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bill.payments.map((payment) => {
                            const reversed = isReversed(payment, bill.payments);
                            const reversible =
                              toCents(payment.amount) > 0 &&
                              payment.reversedPaymentId == null &&
                              !reversed;
                            return (
                              <tr key={payment.id} className="border-b border-border/60 last:border-0">
                                <td className="py-2 pr-2">
                                  <div className="font-medium">{payment.receiptNo}</div>
                                  {payment.reversedReceiptNo ? (
                                    <div className="text-xs text-muted-foreground">
                                      reverses {payment.reversedReceiptNo}
                                    </div>
                                  ) : null}
                                  {reversed ? (
                                    <div className="text-xs text-muted-foreground">reversed</div>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-2">
                                  {PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}
                                  {payment.reference ? (
                                    <div className="text-xs text-muted-foreground">
                                      {payment.reference}
                                    </div>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-2 text-xs text-muted-foreground">
                                  {formatDateTime(payment.createdAt)}
                                  {payment.cashierName ? ` · ${payment.cashierName}` : ""}
                                </td>
                                <td className="py-2 pr-2 text-right font-medium">
                                  {money(payment.amount)}
                                </td>
                                <td className="py-2 text-right">
                                  {reversible ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      data-testid="reverse-payment"
                                      onClick={() => {
                                        setReverseTargetId(payment.id);
                                        setReverseReason("");
                                      }}
                                    >
                                      <RotateCcw aria-hidden /> Reverse
                                    </Button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {reverseTargetId ? (
                    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-background p-3">
                      <div className="space-y-1">
                        <Label className="text-xs" htmlFor="reverse-reason">
                          Reversal reason
                        </Label>
                        <Input
                          id="reverse-reason"
                          data-testid="reverse-reason"
                          value={reverseReason}
                          onChange={(event) => setReverseReason(event.target.value)}
                          className="h-8 w-72"
                          placeholder="Why is this payment being reversed?"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        data-testid="confirm-reverse"
                        disabled={busy != null}
                        onClick={() => void reversePayment()}
                      >
                        <RotateCcw aria-hidden /> Confirm reversal
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setReverseTargetId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </section>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className={cn(CARD_CLASS, "p-4")} data-testid="session-panel">
            <h3 className={SECTION_TITLE_CLASS}>
              <Wallet aria-hidden className="mr-1 inline size-4" />
              Drawer
            </h3>
            {session ? (
              <div className="mt-3 space-y-3">
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Opened</dt>
                    <dd>{formatDateTime(session.openedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Opening float</dt>
                    <dd>{money(session.openingFloat)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Collected</dt>
                    <dd>{money(session.totalCollected)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Receipts</dt>
                    <dd>{session.paymentCount}</dd>
                  </div>
                </dl>
                <div className="rounded-lg border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">Collected by method</p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {session.totals.map((total) => (
                      <li key={total.method} className="flex items-center justify-between">
                        <span>
                          {PAYMENT_METHOD_LABELS[total.method]} ({total.count})
                        </span>
                        <span className="font-medium">{money(total.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="counted-cash">
                      Counted cash
                    </Label>
                    <Input
                      id="counted-cash"
                      data-testid="counted-cash"
                      type="number"
                      min="0"
                      step="0.01"
                      value={countedCash}
                      onChange={(event) => setCountedCash(event.target.value)}
                      className="h-8 w-36"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="close-note">
                      Note
                    </Label>
                    <Input
                      id="close-note"
                      data-testid="close-note"
                      value={closeNote}
                      onChange={(event) => setCloseNote(event.target.value)}
                      className="h-8 w-48"
                      placeholder="Optional"
                    />
                  </div>
                  <Button
                    type="button"
                    data-testid="close-session"
                    disabled={busy != null}
                    onClick={() => void closeSession()}
                  >
                    <CheckCircle2 aria-hidden /> Close session
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="opening-float-2">
                    Opening float
                  </Label>
                  <Input
                    id="opening-float-2"
                    data-testid="opening-float-sessions"
                    type="number"
                    min="0"
                    step="0.01"
                    value={sessionFloat}
                    onChange={(event) => setSessionFloat(event.target.value)}
                    className="h-8 w-36"
                  />
                </div>
                <Button
                  type="button"
                  data-testid="open-session-sessions"
                  disabled={busy != null}
                  onClick={() => void openSession()}
                >
                  <Wallet aria-hidden /> Open session
                </Button>
              </div>
            )}
          </section>

          <section className={cn(CARD_CLASS, "p-4")}>
            <h3 className={SECTION_TITLE_CLASS}>
              <Receipt aria-hidden className="mr-1 inline size-4" />
              Recent sessions
            </h3>
            {recentSessions.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No sessions yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {recentSessions.map((entry) => (
                  <li key={entry.sessionId} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <p className="text-sm">
                        {formatDateTime(entry.openedAt)}
                        {entry.closedAt ? ` → ${formatDateTime(entry.closedAt)}` : " · open"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {money(entry.totalCollected)} · {entry.paymentCount} receipts
                        {entry.variance != null ? ` · variance ${money(entry.variance)}` : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="view-report"
                      onClick={() => void loadReport(entry.sessionId)}
                    >
                      Report <ArrowRight aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            className={cn(CARD_CLASS, "p-4 lg:col-span-2")}
            data-testid="eod-report"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className={SECTION_TITLE_CLASS}>
                <FileText aria-hidden className="mr-1 inline size-4" />
                End-of-day report
              </h3>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="load-report"
                  disabled={!session && !reportSessionId}
                  onClick={() => {
                    const target = session?.sessionId ?? reportSessionId;
                    if (target) void loadReport(target);
                  }}
                >
                  <RefreshCw aria-hidden /> Load current
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="print-report"
                  disabled={!report}
                  onClick={printReport}
                >
                  <Printer aria-hidden /> Print
                </Button>
              </div>
            </div>
            {!report ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Choose a session to see the reconciliation.
              </p>
            ) : (
              <div className="mt-3 space-y-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Opening float</dt>
                    <dd className="font-medium">{money(report.session.openingFloat)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Collected</dt>
                    <dd className="font-medium">{money(report.totalCollected)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Reversed</dt>
                    <dd className="font-medium">{money(report.totalReversed)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Cash expected</dt>
                    <dd className="font-medium">{money(report.cashExpected)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Counted cash</dt>
                    <dd className="font-medium">{money(report.session.countedCash)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Variance</dt>
                    <dd
                      className={cn(
                        "font-medium",
                        report.session.variance != null &&
                          toCents(report.session.variance) !== 0 &&
                          "text-[var(--status-critical-foreground)]",
                      )}
                    >
                      {money(report.session.variance)}
                    </dd>
                  </div>
                </dl>
                <div className="grid gap-3 sm:grid-cols-4">
                  {report.totals.map((total) => (
                    <div
                      key={total.method}
                      className="rounded-lg border border-border bg-background p-3"
                    >
                      <p className="text-xs text-muted-foreground">
                        {PAYMENT_METHOD_LABELS[total.method]}
                      </p>
                      <p className="text-sm font-semibold">{money(total.amount)}</p>
                      <p className="text-xs text-muted-foreground">{total.count} receipts</p>
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Receipts in this session
                  </h4>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-2 font-medium">Receipt</th>
                          <th className="py-2 pr-2 font-medium">Invoice</th>
                          <th className="py-2 pr-2 font-medium">Patient</th>
                          <th className="py-2 pr-2 font-medium">Method</th>
                          <th className="py-2 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.payments.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-3 text-center text-muted-foreground">
                              No receipts in this session.
                            </td>
                          </tr>
                        ) : (
                          report.payments.map((payment) => (
                            <tr key={payment.paymentId} className="border-b border-border/60 last:border-0">
                              <td className="py-2 pr-2">
                                {payment.receiptNo}
                                {payment.isReversal ? " (reversal)" : ""}
                              </td>
                              <td className="py-2 pr-2">{payment.invoiceNo}</td>
                              <td className="py-2 pr-2">
                                {payment.patientName}
                                <span className="block text-xs text-muted-foreground">
                                  {payment.mrn}
                                </span>
                              </td>
                              <td className="py-2 pr-2">
                                {PAYMENT_METHOD_LABELS[payment.method]}
                              </td>
                              <td className="py-2 text-right font-medium">{money(payment.amount)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <CreditCard aria-hidden className="size-3.5" />
                    {report.invoiceCount} invoices touched
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 aria-hidden className="size-3.5" />
                    {report.paidInvoiceCount} paid in full
                  </span>
                  <span>Net collected {money(report.netCollected)}</span>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
