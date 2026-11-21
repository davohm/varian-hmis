/** Shared tax and eTIMS vocabulary. No credentials or endpoint secrets live here. */

export const TAX_TREATMENTS = ["vat_standard", "vat_zero", "exempt", "out_of_scope"] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  vat_standard: "VAT standard",
  vat_zero: "VAT zero-rated",
  exempt: "VAT exempt",
  out_of_scope: "Out of scope",
};

export const ETIMS_DOCUMENT_TYPES = ["invoice", "credit_note", "debit_note"] as const;
export type EtimsDocumentType = (typeof ETIMS_DOCUMENT_TYPES)[number];

export const ETIMS_MODES = ["oscu", "vscu"] as const;
export type EtimsMode = (typeof ETIMS_MODES)[number];

export const ETIMS_QUEUE_STATUSES = [
  "pending",
  "transmitting",
  "transmitted",
  "acknowledged",
  "rejected",
  "failed",
  "cancelled",
] as const;
export type EtimsQueueStatus = (typeof ETIMS_QUEUE_STATUSES)[number];

export const ETIMS_QUEUE_STATUS_LABELS: Record<EtimsQueueStatus, string> = {
  pending: "Pending",
  transmitting: "Transmitting",
  transmitted: "Transmitted",
  acknowledged: "Acknowledged",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const ETIMS_SANDBOX_STUB_URL = "sandbox://kra.etims.local";
export const DEFAULT_ETIMS_SPEC_VERSION = "oscu-1.0";
export const DEFAULT_ETIMS_STALE_SECONDS = 900;

export interface EtimsDocumentLine {
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

/** Immutable snapshot used to build the exact KRA request payload. */
export interface EtimsDocumentSnapshot {
  queueId: string;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  kraPin: string;
  idempotencyKey: string;
  invoiceNo: string;
  invoiceDate: string;
  documentType: EtimsDocumentType;
  creditNoteOf: string | null;
  originalInvoiceNo: string | null;
  buyerPin: string | null;
  buyerName: string | null;
  buyerType: string | null;
  currency: string;
  totalAmount: string;
  taxAmount: string;
  lines: EtimsDocumentLine[];
}

export interface EtimsRequestPayload {
  specVersion: string;
  channel: "OSCU" | "VSCU";
  environment: "sandbox" | "production";
  requestId: string;
  documentType: EtimsDocumentType;
  invoice: {
    number: string;
    date: string;
    creditNoteOf: string | null;
    currency: string;
    totalAmount: string;
    taxAmount: string;
  };
  seller: {
    name: string;
    pin: string;
    branchCode: string;
  };
  buyer: {
    name: string | null;
    pin: string | null;
    type: string | null;
  };
  lines: EtimsDocumentLine[];
}

export interface EtimsResponsePayload {
  resultCode?: string | number;
  resultMsg?: string;
  controlNo?: string;
  signature?: string;
  qrUrl?: string;
  cuNo?: string;
  [key: string]: unknown;
}

export interface EtimsAcknowledgeResult {
  outcome: "acknowledged";
  controlNo: string;
  signature: string;
  qrUrl: string;
  cuNo: string | null;
  responseCode: string;
  responseMessage: string;
}

export interface EtimsRejectResult {
  outcome: "rejected";
  responseCode: string;
  responseMessage: string;
}

export interface EtimsFailureResult {
  outcome: "failed";
  responseCode: string;
  responseMessage: string;
}

export type EtimsResult = EtimsAcknowledgeResult | EtimsRejectResult | EtimsFailureResult;

export interface EtimsClientConfig {
  baseUrl: string;
  environment: "sandbox" | "production";
  mode: EtimsMode;
  specVersion: string;
  timeoutMs: number;
  /** Name of a server-side environment variable; never the secret itself. */
  credentialRef?: string | null;
}

export interface EtimsIntegrationConfiguration extends EtimsClientConfig {
  id: string;
  enabled: boolean;
  maxAttempts: number;
  backoffSeconds: number[];
}

export interface EtimsHttpResponse {
  status: number;
  payload: EtimsResponsePayload;
}

export type EtimsTransport = (
  payload: EtimsRequestPayload,
  config: EtimsClientConfig,
) => Promise<EtimsHttpResponse>;

export function isEtimsAcknowledged(result: EtimsResult): result is EtimsAcknowledgeResult {
  return result.outcome === "acknowledged";
}

export function etimsStatusTone(status: EtimsQueueStatus): "neutral" | "info" | "success" | "danger" {
  if (status === "acknowledged" || status === "transmitted") return "success";
  if (status === "pending" || status === "transmitting") return "info";
  if (status === "rejected" || status === "failed") return "danger";
  return "neutral";
}
