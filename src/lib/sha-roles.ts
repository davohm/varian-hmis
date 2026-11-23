import type { Role } from "@/server/db/schema/staff";

import {
  SHA_APPROVAL_ROLES,
  SHA_CLAIM_ROLES,
  SHA_CO_PAY_ROLES,
  SHA_ELIGIBILITY_ROLES,
  SHA_FINANCE_ROLES,
  SHA_SETUP_ROLES,
} from "./navigation";

/**
 * Single source of truth for the /api/sha command surface. The route handler
 * types its handler map with ShaCommandName, so a command cannot be added on
 * one side without being added here too.
 */
export const SHA_COMMAND_NAMES = [
  "createEmpanelment",
  "updateEmpanelmentStatus",
  "createBenefitPackage",
  "verifyShaEligibility",
  "recordShaCoPay",
  "requestShaWaiver",
  "approveWaiver",
  "approveExemption",
  "requestShaPreAuthorization",
  "decideShaPreAuthorization",
  "createShaClaim",
  "submitShaClaim",
  "recordShaAdjudication",
  "recordShaDenial",
  "reworkShaClaim",
  "recordShaRemittance",
  "reconcileShaPaymentReport",
] as const;

export type ShaCommandName = (typeof SHA_COMMAND_NAMES)[number];

export const SHA_COMMAND_ROLES: Record<ShaCommandName, Role[]> = {
  createEmpanelment: SHA_SETUP_ROLES,
  updateEmpanelmentStatus: SHA_SETUP_ROLES,
  createBenefitPackage: SHA_SETUP_ROLES,
  verifyShaEligibility: SHA_ELIGIBILITY_ROLES,
  recordShaCoPay: SHA_CO_PAY_ROLES,
  requestShaWaiver: SHA_CLAIM_ROLES,
  approveWaiver: SHA_APPROVAL_ROLES,
  approveExemption: SHA_APPROVAL_ROLES,
  requestShaPreAuthorization: SHA_CLAIM_ROLES,
  decideShaPreAuthorization: SHA_APPROVAL_ROLES,
  createShaClaim: SHA_CLAIM_ROLES,
  submitShaClaim: SHA_CLAIM_ROLES,
  recordShaAdjudication: SHA_APPROVAL_ROLES,
  recordShaDenial: SHA_CLAIM_ROLES,
  reworkShaClaim: SHA_CLAIM_ROLES,
  recordShaRemittance: SHA_FINANCE_ROLES,
  reconcileShaPaymentReport: SHA_FINANCE_ROLES,
};
