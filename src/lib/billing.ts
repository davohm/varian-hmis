/** Shared cashier rules used by commands, queries and the workspace. */

export const SERVICE_KINDS = ["consultation", "lab", "procedure", "drug"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const INVOICE_STATUSES = ["open", "partial", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "mpesa", "card", "insurance"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  mpesa: "M-Pesa",
  card: "Card",
  insurance: "Insurance",
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  open: "Open",
  partial: "Part paid",
  paid: "Paid",
  void: "Void",
};

/** 80 mm thermal paper: 40 monospace characters at the standard font. */
export const RECEIPT_WIDTH_MM = 80;
export const RECEIPT_WIDTH_CHARS = 40;

/**
 * Parse a money value into integer cents. The database stores numeric(12,2),
 * so values arrive as strings such as "1350.00"; never do float arithmetic on
 * money outside these helpers.
 */
export function toCents(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const text = typeof value === "number" ? value.toFixed(2) : String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid money value: ${String(value)}`);
    return Math.round(parsed * 100);
  }
  const sign = match[1] ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100 + fraction);
}

/** Render integer cents back into the numeric(12,2) string the database expects. */
export function fromCents(cents: number): string {
  if (!Number.isFinite(cents)) throw new Error(`Invalid cents value: ${String(cents)}`);
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  const absolute = Math.abs(rounded);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function lineAmount(unitPrice: string | number, quantity: number): string {
  return fromCents(toCents(unitPrice) * Math.trunc(quantity));
}

export function sumAmounts(values: Array<string | number>): string {
  return fromCents(values.reduce<number>((total, value) => total + toCents(value), 0));
}

/** A zero-value invoice is settled as soon as it is raised. */
export function invoiceStatus(
  total: string | number,
  paid: string | number,
): Exclude<InvoiceStatus, "void"> {
  const totalCents = toCents(total);
  const paidCents = toCents(paid);
  if (totalCents <= 0) return "paid";
  if (paidCents <= 0) return "open";
  if (paidCents >= totalCents) return "paid";
  return "partial";
}

export function outstandingAmount(
  total: string | number,
  paid: string | number,
): string {
  const outstanding = toCents(total) - toCents(paid);
  return fromCents(Math.max(0, outstanding));
}

export interface TenderInput {
  method: PaymentMethod | string;
  amount: string | number;
}

/**
 * Validate a split tender before a single receipt is issued. A payment may be
 * partial, but it may never exceed the outstanding balance.
 */
export function validateTenders(
  total: string | number,
  paid: string | number,
  tenders: TenderInput[],
): { totalCents: number; paidCents: number; tenderCents: number } {
  const totalCents = toCents(total);
  const paidCents = toCents(paid);
  const outstanding = Math.max(0, totalCents - paidCents);

  if (tenders.length === 0) throw new Error("Add at least one tender");
  if (outstanding <= 0) throw new Error("This invoice is already fully paid");

  let tenderCents = 0;
  for (const tender of tenders) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(tender.method)) {
      throw new Error(`Unknown payment method: ${tender.method}`);
    }
    const amount = toCents(tender.amount);
    if (amount <= 0) throw new Error("Tender amounts must be greater than zero");
    tenderCents += amount;
  }

  if (tenderCents > outstanding) {
    throw new Error(
      `The tenders exceed the outstanding balance of ${fromCents(outstanding)}`,
    );
  }

  return { totalCents, paidCents, tenderCents };
}

/** Cash in the drawer at close: opening float plus net cash movements. */
export function sessionExpectedCash(
  openingFloat: string | number,
  payments: Array<{ method: string; amount: string | number }>,
): string {
  const cash = payments
    .filter((payment) => payment.method === "cash")
    .reduce((total, payment) => total + toCents(payment.amount), 0);
  return fromCents(toCents(openingFloat) + cash);
}

export function varianceAmount(
  countedCash: string | number,
  expectedCash: string | number,
): string {
  return fromCents(toCents(countedCash) - toCents(expectedCash));
}

export interface ReceiptLine {
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface ReceiptPayment {
  receiptNo: string;
  method: string;
  amount: string;
  receivedAt: string;
}

export interface ReceiptData {
  facilityName: string;
  facilityPhone: string | null;
  branchName: string | null;
  patientName: string;
  mrn: string;
  encounterNo: string;
  invoiceNo: string;
  receiptNo: string;
  issuedAt: string;
  cashier: string;
  lines: ReceiptLine[];
  total: string;
  paid: string;
  outstanding: string;
  payment: { method: string; amount: string; reference: string | null };
  payments: ReceiptPayment[];
}

function center(text: string): string {
  const clean = text.slice(0, RECEIPT_WIDTH_CHARS);
  const pad = Math.max(0, Math.floor((RECEIPT_WIDTH_CHARS - clean.length) / 2));
  return `${" ".repeat(pad)}${clean}`;
}

function columns(left: string, right: string, width = RECEIPT_WIDTH_CHARS): string {
  const rightText = right.slice(0, width);
  const leftWidth = Math.max(0, width - rightText.length - 1);
  const leftText = left.length > leftWidth ? `${left.slice(0, Math.max(0, leftWidth - 1))}…` : left;
  return `${leftText.padEnd(leftWidth)} ${rightText}`;
}

function rule(): string {
  return "-".repeat(RECEIPT_WIDTH_CHARS);
}

function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Plain-text receipt for the 80 mm printer. The workspace prints a styled
 * version of the same data, so a hardware print and a screen print agree.
 */
export function renderReceiptText(receipt: ReceiptData): string {
  const lines: string[] = [];
  lines.push(center(receipt.facilityName));
  if (receipt.branchName) lines.push(center(receipt.branchName));
  if (receipt.facilityPhone) lines.push(center(receipt.facilityPhone));
  lines.push(rule());
  lines.push(columns("Receipt", receipt.receiptNo));
  lines.push(columns("Invoice", receipt.invoiceNo));
  lines.push(columns("Date", dateTime(receipt.issuedAt)));
  lines.push(columns("Patient", receipt.mrn));
  lines.push(columns("Visit", receipt.encounterNo));
  lines.push(columns("Cashier", receipt.cashier));
  lines.push(rule());
  for (const line of receipt.lines) {
    lines.push(columns(line.description, line.amount));
    if (line.quantity > 1) {
      lines.push(columns(`  ${line.quantity} x ${line.unitPrice}`, ""));
    }
  }
  lines.push(rule());
  lines.push(columns("Total", receipt.total));
  lines.push(columns("Paid", receipt.paid));
  lines.push(columns("Balance", receipt.outstanding));
  lines.push(rule());
  lines.push(
    columns(
      `Payment: ${PAYMENT_METHOD_LABELS[receipt.payment.method as PaymentMethod] ?? receipt.payment.method}`,
      receipt.payment.amount,
    ),
  );
  if (receipt.payment.reference) {
    lines.push(columns("Ref", receipt.payment.reference));
  }
  lines.push(rule());
  lines.push(center("Thank you. Keep this receipt."));
  return lines.join("\n");
}
