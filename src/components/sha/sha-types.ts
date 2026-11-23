/** Client shapes returned by /api/sha. Kept explicit so the workspace stays typed. */

export {
  formatDate,
  formatMoney,
  monthStartIso,
  todayIso,
} from "@/components/finance/finance-types";

import type {
  PatientResult,
  PayerContractRow,
  PayerRow,
  RevenueEncounterRow,
} from "@/components/revenue/revenue-types";

export type ShaTab =
  | "empanelment"
  | "eligibility"
  | "preauth"
  | "claims"
  | "remittances"
  | "reconciliation"
  | "denials";

export interface ShaEmpanelmentRow {
  id: string;
  kmpdcNumber: string | null;
  fund: string;
  schemeCode: string;
  schemeName: string | null;
  contractNo: string | null;
  contractStatus: string;
  effectiveFrom: string;
  expiryDate: string | null;
  tariffVersion: string | null;
  qualityCertProgram: string | null;
  qualityCertExpiry: string | null;
  openedAt: string;
  closedAt: string | null;
  closureReason: string | null;
  createdAt: string;
}

export interface BenefitPackageItemRow {
  id: string;
  serviceId: string | null;
  itemId: string | null;
  shaServiceCode: string | null;
  category: string | null;
  description: string | null;
  coverage: string;
  limitAmount: string | null;
  limitDays: string | null;
  limitVisits: string | null;
  requiresPreauth: boolean;
  preauthThreshold: string | null;
  coPayPercent: string;
  unitPrice: string;
  notes: string | null;
}

export interface BenefitPackageRow {
  id: string;
  fund: string;
  packageCode: string;
  name: string;
  careLevel: string | null;
  careType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  items: BenefitPackageItemRow[];
  createdAt: string;
}

export interface EligibilityCheckRow {
  id: string;
  patientId: string;
  payerId: string | null;
  empanelmentId: string | null;
  fund: string | null;
  memberRef: string | null;
  eligibility: string;
  checkRef: string | null;
  checkedAt: string;
  notes: string | null;
}

export interface PatientBenefitCoverage {
  patient: {
    id: string;
    mrn: string;
    name: string;
    payerType: string;
    payerMemberNo: string | null;
  };
  eligibility: EligibilityCheckRow | null;
  checks: EligibilityCheckRow[];
  packages: BenefitPackageRow[];
}

export interface ShaCoPayLine {
  description: string;
  shaServiceCode: string | null;
  coverage: string;
  billed: string;
  patientCoPay: string;
  preauthRequired: boolean;
}

export interface ShaCoPayAssessmentRow {
  id: string;
  patientId: string;
  encounterId: string;
  invoiceId: string;
  empanelmentId: string;
  benefitPackageId: string;
  eligibilityCheckId: string | null;
  payerId: string | null;
  fund: string;
  amount: string;
  lines: ShaCoPayLine[];
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
  createdAt: string;
}

export interface ShaClaimRow {
  id: string;
  claimNo: string;
  shaClaimRef: string | null;
  fund: string | null;
  status: string;
  patientId: string;
  patientName: string;
  mrn: string;
  encounterId: string;
  encounterNo: string;
  invoiceId: string | null;
  invoiceNo: string | null;
  payerName: string;
  empanelmentId: string | null;
  benefitPackageId: string | null;
  billedAmount: string;
  patientCoPay: string;
  total: string;
  approvedAmount: string;
  paidAmount: string;
  outstanding: string;
  adjudicationCode: string | null;
  submissionBatch: string | null;
  submittedAt: string | null;
  createdAt: string;
  supersedesClaimId: string | null;
  denialCount: number;
}

export interface ShaClaimDetail extends ShaClaimRow {
  notes: string | null;
  tariffVersion: string | null;
  adjudicationStatus: string | null;
  waiverId: string | null;
  preAuthId: string | null;
  coPayAssessmentId: string | null;
  approvedAt: string | null;
  submittedBy: string | null;
  facilityName: string | null;
  facilityAddress: string | null;
  empanelment: {
    id: string;
    kmpdcNumber: string | null;
    fund: string;
    schemeCode: string;
    contractNo: string | null;
    tariffVersion: string | null;
  } | null;
  benefitPackage: { id: string; packageCode: string; name: string } | null;
  invoice: {
    id: string;
    invoiceNo: string;
    total: string;
    status: string;
    isShaClaimable: boolean;
  } | null;
  encounter: { id: string; encounterNo: string; startedAt: string; status: string };
  preAuth: {
    id: string;
    authNo: string;
    shaAuthRef: string | null;
    status: string;
    expiresAt: string | null;
  } | null;
  lines: Array<{
    id: string;
    description: string;
    shaServiceCode: string | null;
    quantity: string;
    unitPrice: string;
    amount: string;
    approvedAmount: string;
    shaPatientPay: boolean;
    shaCoverage: string | null;
    shaBilledAmount: string;
    shaPatientAmount: string;
    shaPreauthRequired: boolean;
    denialCode: string | null;
    denialReason: string | null;
  }>;
  remittances: Array<{
    id: string;
    remittanceNo: string;
    amount: string;
    receivedAt: string;
    shaPaymentReportRef: string | null;
    bankReference: string | null;
    paymentDate: string | null;
    reference: string | null;
    claimLineId: string | null;
  }>;
  denials: Array<{
    id: string;
    amount: string;
    code: string | null;
    reason: string;
    status: string;
    createdAt: string;
  }>;
}

export interface ShaRemittanceRow {
  id: string;
  remittanceNo: string;
  claimId: string;
  claimNo: string;
  shaClaimRef: string | null;
  patientName: string;
  amount: string;
  receivedAt: string;
  shaPaymentReportRef: string | null;
  bankReference: string | null;
  paymentDate: string | null;
  reference: string | null;
  claimLineId: string | null;
  lineDescription: string | null;
}

export interface ShaReconciliationLineRow {
  id: string;
  claimId: string | null;
  claimNo: string | null;
  shaAmount: string;
  facilityAmount: string;
  variance: string;
  status: string;
  reason: string | null;
}

export interface ShaReconciliationRow {
  id: string;
  kmpdcNumber: string;
  reportPeriod: string;
  reportRef: string | null;
  shaReportedAmount: string;
  facilityInvoicedAmount: string;
  matchedAmount: string;
  unmatchedAmount: string;
  variance: string;
  status: string;
  journalEntryNo: string | null;
  generatedAt: string;
  lines: ShaReconciliationLineRow[];
}

export interface ShaAdjudicationCodeRow {
  id: string;
  code: string;
  description: string;
  category: string;
  retryable: boolean;
  actionHint: string | null;
}

export interface ShaPreAuthRow {
  id: string;
  authNo: string;
  shaAuthRef: string | null;
  patientId: string;
  patientName: string;
  fund: string | null;
  status: string;
  requestedAmount: string;
  approvedAmount: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ShaWaiverRow {
  id: string;
  kind: string;
  claimId: string | null;
  claimNo: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  amount: string;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  status: string;
  decidedAt: string | null;
  createdAt: string;
}

export interface ShaAgeingBucket {
  label: string;
  claimCount: number;
  outstanding: string;
}

export interface ShaData {
  empanelments: ShaEmpanelmentRow[];
  benefitPackages: BenefitPackageRow[];
  eligibilityChecks: EligibilityCheckRow[];
  coPayAssessments: ShaCoPayAssessmentRow[];
  preAuthorizations: ShaPreAuthRow[];
  claims: ShaClaimRow[];
  claimDetail: ShaClaimDetail | null;
  remittances: ShaRemittanceRow[];
  waivers: ShaWaiverRow[];
  reconciliations: Array<Omit<ShaReconciliationRow, "lines">>;
  reconciliation: ShaReconciliationRow | null;
  adjudicationCodes: ShaAdjudicationCodeRow[];
  ageing: ShaAgeingBucket[];
  coverage: PatientBenefitCoverage | null;
  benefitPackage: BenefitPackageRow | null;
  payers: PayerRow[];
  contracts: PayerContractRow[];
  encounters: RevenueEncounterRow[];
  patients: PatientResult[];
}

export interface ShaCapabilities {
  canSetup: boolean;
  canVerifyEligibility: boolean;
  canRecordCoPay: boolean;
  canApprove: boolean;
  canClaim: boolean;
  canFinance: boolean;
}

export const SHA_TABS: Array<{ id: ShaTab; label: string }> = [
  { id: "empanelment", label: "Empanelment" },
  { id: "eligibility", label: "Eligibility" },
  { id: "preauth", label: "Pre-authorisation" },
  { id: "claims", label: "Claims" },
  { id: "remittances", label: "Remittances" },
  { id: "reconciliation", label: "Reconciliation" },
  { id: "denials", label: "Denials" },
];

export const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  active: "success",
  approved: "success",
  paid: "success",
  accepted: "success",
  matched: "success",
  posted: "success",
  eligible: "success",
  requested: "warning",
  submitted: "info",
  queried: "warning",
  resubmitted: "info",
  open: "warning",
  variance: "danger",
  unmatched: "danger",
  draft: "neutral",
  suspended: "danger",
  expired: "danger",
  ineligible: "danger",
  terminated: "danger",
  declined: "danger",
  rejected: "danger",
  pending: "warning",
  unknown: "warning",
  closed: "neutral",
};

export class ShaCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "ShaCommandError";
  }
}

/** Posts a scoped SHA command. Facility and actor are injected by the API. */
export async function postShaCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/sha", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "sha-workspace" },
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
    throw new ShaCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}
