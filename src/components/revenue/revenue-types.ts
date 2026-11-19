/** Shapes returned by /api/revenue and the shared revenue command client. */

export { formatDate, formatMoney, monthStartIso, todayIso } from "@/components/finance/finance-types";

export type RevenueTab = "overview" | "payers" | "preauth" | "claims" | "remittances" | "denials";

export interface PayerRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
  contractCount: number;
}

export interface PayerContractRow {
  id: string;
  payerId: string;
  payerName: string;
  contractNo: string;
  startDate: string;
  endDate: string;
  status: string;
  benefitCount: number;
}

export interface PreAuthorizationRow {
  id: string;
  authNo: string;
  payerId: string;
  payerName: string;
  patientId: string;
  patientName: string;
  encounterId: string | null;
  requestedAmount: string;
  approvedAmount: string | null;
  status: string;
  reference: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ClaimRow {
  id: string;
  claimNo: string;
  payerId: string;
  payerName: string;
  patientId: string;
  patientName: string;
  encounterId: string;
  invoiceId: string | null;
  status: string;
  total: string;
  approvedAmount: string;
  paidAmount: string;
  outstanding: string;
  submittedAt: string | null;
  createdAt: string;
}

export interface ClaimDetail extends ClaimRow {
  notes: string | null;
  lines: Array<{
    id: string;
    description: string;
    amount: string;
    approvedAmount: string;
    denialReason: string | null;
  }>;
  remittances: Array<{
    id: string;
    remittanceNo: string;
    amount: string;
    receivedAt: string;
    reference: string | null;
  }>;
  denials: Array<{
    id: string;
    amount: string;
    reason: string;
    status: string;
    resolutionNote: string | null;
    createdAt: string;
  }>;
}

export interface RemittanceRow {
  id: string;
  remittanceNo: string;
  claimId: string;
  claimNo: string;
  payerName: string;
  amount: string;
  receivedAt: string;
  reference: string | null;
}

export interface ClaimDenialRow {
  id: string;
  claimId: string;
  claimNo: string;
  payerName: string;
  amount: string;
  reason: string;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
}

export interface ClaimAgeingBucket {
  label: string;
  claimCount: number;
  outstanding: string;
}

export interface RevenueOverview {
  openClaims: number;
  openClaimValue: string;
  outstanding: string;
  paidThisMonth: string;
  openDenials: number;
  denialValue: string;
  pendingPreAuths: number;
  ageing: ClaimAgeingBucket[];
}

export interface RevenueEncounterRow {
  id: string;
  encounterNo: string;
  patientId: string;
  patientName: string;
  mrn: string;
  status: string;
  startedAt: string;
  invoiceId: string | null;
  invoiceNo: string | null;
  invoiceTotal: string | null;
}

export interface PatientResult {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
}

export interface RevenueData {
  overview: RevenueOverview | null;
  payers: PayerRow[];
  contracts: PayerContractRow[];
  preAuthorizations: PreAuthorizationRow[];
  claims: ClaimRow[];
  claimDetail: ClaimDetail | null;
  remittances: RemittanceRow[];
  denials: ClaimDenialRow[];
  encounters: RevenueEncounterRow[];
  patients: PatientResult[];
}

export interface RevenuePanelProps {
  data: RevenueData;
  canWrite: boolean;
  refresh: () => Promise<void>;
  openTab: (tab: RevenueTab) => void;
  selectClaim: (claimId: string) => void;
  selectedClaimId: string;
}

export const PAYER_KINDS = ["cash", "corporate", "insurer", "sha"] as const;
export const CONTRACT_STATUSES = ["active", "suspended", "expired"] as const;
export const CLAIM_STATUSES = [
  "draft",
  "submitted",
  "accepted",
  "queried",
  "rejected",
  "resubmitted",
  "paid",
  "closed",
] as const;

export const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  active: "success",
  approved: "success",
  paid: "success",
  accepted: "success",
  requested: "warning",
  submitted: "info",
  queried: "warning",
  resubmitted: "info",
  open: "warning",
  draft: "neutral",
  suspended: "danger",
  expired: "danger",
  declined: "danger",
  rejected: "danger",
  upheld: "danger",
  overturned: "success",
  closed: "neutral",
};

export class RevenueCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "RevenueCommandError";
  }
}

/** Posts a scoped revenue command. Facility and actor are injected by the API. */
export async function postRevenueCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/revenue", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "revenue-station" },
    body: JSON.stringify({ command, input }),
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
    throw new RevenueCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}
