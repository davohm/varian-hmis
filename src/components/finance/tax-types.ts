/** Shapes returned by /api/finance/tax and the scoped command client. */

import { FinanceCommandError, formatDate, formatMoney } from "@/components/finance/finance-types";
import {
  ETIMS_QUEUE_STATUS_LABELS,
  TAX_TREATMENT_LABELS,
  type EtimsDocumentType,
  type EtimsQueueStatus,
  type TaxTreatment,
} from "@/lib/tax";

export interface EtimsTransactionRow {
  transNo: string;
  queueId: string;
  invoiceNo: string;
  company: string;
  date: string;
  patient: string;
  amount: string;
  status: EtimsQueueStatus;
  documentType: EtimsDocumentType;
  environment: "sandbox" | "production";
  attempts: number;
  kraControlNo: string | null;
  kraSignature: string | null;
  qrUrl: string | null;
  cuNo: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  buyerName: string | null;
  creditNoteOf: string | null;
}

export interface EtimsTransactionLine {
  lineNo: number;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
  taxCode: string | null;
  taxTreatment: TaxTreatment | null;
  taxRate: string;
  taxAmount: string;
}

export interface EtimsTransactionDetail extends EtimsTransactionRow {
  invoiceId: string | null;
  responseCode: string | null;
  responseMessage: string | null;
  lines: EtimsTransactionLine[];
}

export interface TaxCodeRow {
  id: string;
  code: string;
  name: string;
  rate: string;
  treatment: TaxTreatment;
  kraCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  isDefault: boolean;
  version: number;
}

export interface FinalisableInvoiceRow {
  id: string;
  invoiceNo: string;
  total: string;
  status: string;
  createdAt: string;
  patient: string | null;
  finalizedAt: string | null;
}

export interface EtimsIntegrationRow {
  id: string;
  environment: "sandbox" | "production";
  baseUrl: string | null;
  specVersion: string | null;
  mode: string | null;
  credentialRef: string | null;
  timeoutMs: number;
  maxAttempts: number;
  backoffSeconds: number[];
  enabled: boolean;
  lastVerifiedAt: string | null;
}

export interface TaxResponse {
  transactions: EtimsTransactionRow[];
  detail: EtimsTransactionDetail | null;
  taxCodes: TaxCodeRow[];
  invoices: FinalisableInvoiceRow[];
  integrations: EtimsIntegrationRow[];
  summary: {
    total: number;
    acknowledged: number;
    pending: number;
    failed: number;
  };
}

export interface EtimsStatusResponse {
  status: {
    queue: {
      queueId: string;
      status: EtimsQueueStatus;
      attempts: number;
    };
    attempts: number;
    lastError: string | null;
    kraControlNo: string | null;
    kraSignature: string | null;
    qrUrl: string | null;
    nextAttemptAt: string | null;
    logs: Array<{
      attempt: number;
      outcome: string;
      httpStatus: number | null;
      responseCode: string | null;
      createdAt: string;
    }>;
  };
}

export function queueStatusLabel(status: EtimsQueueStatus): string {
  return ETIMS_QUEUE_STATUS_LABELS[status] ?? status;
}

export function queueStatusTone(status: EtimsQueueStatus): "neutral" | "info" | "success" | "danger" {
  if (status === "acknowledged" || status === "transmitted") return "success";
  if (status === "pending" || status === "transmitting") return "info";
  if (status === "rejected" || status === "failed") return "danger";
  return "neutral";
}

export function taxTreatmentLabel(treatment: TaxTreatment | null): string {
  return treatment ? TAX_TREATMENT_LABELS[treatment] : "—";
}

export { formatDate, formatMoney };

/** Posts a facility-scoped tax command. Facility and actor come from the session. */
export async function postTaxCommand<T>(
  command: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/api/finance/tax", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "finance-station" },
    body: JSON.stringify({
      command,
      input: { idempotencyKey: crypto.randomUUID(), ...input },
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    result?: T;
    error?: string;
    issues?: Array<{ message?: string; path?: Array<string | number> }>;
  } | null;
  if (!response.ok || !body) {
    const issues = (body?.issues ?? [])
      .map((issue) =>
        issue.path && issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message ?? "invalid"}`
          : (issue.message ?? "invalid"),
      )
      .filter(Boolean);
    throw new FinanceCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}
