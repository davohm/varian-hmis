import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import { assertClaimTransition, claimOutstanding, type ClaimStatus } from "@/lib/finance";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { ForbiddenError } from "@/server/auth/guards";
import {
  benefitPackageItems,
  benefitPackages,
  claimDenials,
  claimLines,
  claims,
  encounters,
  facilities,
  facilityLicences,
  facilityRegulatoryProfiles,
  invoices,
  payers,
  patients,
  preAuthorizations,
  remittances,
  shaAdjudicationCodes,
  shaCoPayAssessments,
  shaEligibilityChecks,
  shaEmpanelments,
  shaPaymentReconciliation,
  shaReconciliationLines,
  shaWaivers,
} from "@/server/db/schema";
import { db, type AppDatabase } from "@/server/db/client";
import { publishEvent } from "@/server/events";
import { tryPostJournal } from "@/server/ledger";
import { nextFormattedNumber } from "@/server/numbering";

import { assertValidPayerSharingConsent } from "./privacy";
import { assertFacilityReady } from "./regulatory";
import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

/* ------------------------------------------------------------------ */
/* Shared schema and helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * A refused excess remittance rolls its transaction back, so the refusal is
 * recorded on the default connection to leave a durable audit trail.
 */
async function auditExcessRemittanceRefusal(
  database: AppDatabase,
  values: {
    facilityId: string;
    actor: { userId?: string | null; ip?: string | null; deviceId?: string | null };
  },
  userId: string,
  claim: { id: string; claimNo: string },
  details: Record<string, unknown>,
) {
  await recordAudit(database, {
    facilityId: values.facilityId,
    userId,
    action: "sha_remittance.excess_refused",
    module: "revenue",
    entity: "claims",
    entityId: claim.id,
    details: { claimNo: claim.claimNo, ...details },
    deviceId: values.actor.deviceId,
    ip: values.actor.ip,
  });
}

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)");
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM for a report period");
const money = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)));
const positiveMoney = money.refine((value) => toCents(value) > 0, {
  message: "The amount must be greater than zero",
});

const shaClaimLineSchema = z.object({
  chargeId: z.uuid().nullable().optional(),
  serviceId: z.uuid().nullable().optional(),
  itemId: z.uuid().nullable().optional(),
  shaServiceCode: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().min(1).max(500),
  amount: positiveMoney,
  unitPrice: money.nullable().optional(),
  quantity: z.number().positive().max(10000).default(1),
  /** Explicit patient-pay line: excluded benefits are never billed to SHA. */
  patientPay: z.boolean().default(false),
});

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertDifferentActor(actor: string, prior: string | null | undefined, message: string) {
  if (prior && prior === actor) throw new ForbiddenError(message);
}

async function loadFacility(tx: CommandTransaction, facilityId: string) {
  const rows = await tx
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const facility = rows[0];
  if (!facility) throw new Error("Facility not found");
  return facility;
}

async function loadClaim(tx: CommandTransaction, facilityId: string, claimId: string) {
  const rows = await tx
    .select()
    .from(claims)
    .where(and(eq(claims.facilityId, facilityId), eq(claims.id, claimId)))
    .limit(1)
    .for("update");
  const claim = rows[0];
  if (!claim) throw new Error("SHA claim not found in this facility");
  return claim;
}

/** An empanelment can only be used while active, in date and not closed. */
async function assertActiveEmpanelment(
  tx: CommandTransaction,
  facilityId: string,
  empanelmentId: string,
  fund: string,
  today = todayIso(),
) {
  const rows = await tx
    .select()
    .from(shaEmpanelments)
    .where(
      and(
        eq(shaEmpanelments.facilityId, facilityId),
        eq(shaEmpanelments.id, empanelmentId),
        eq(shaEmpanelments.fund, fund as "phf"),
      ),
    )
    .limit(1);
  const empanelment = rows[0];
  if (!empanelment) throw new Error("SHA empanelment not found for this fund");
  if (empanelment.contractStatus === "terminated") {
    throw new Error("The SHA empanelment is terminated; new claims are blocked");
  }
  if (empanelment.contractStatus === "expired") {
    throw new Error("The SHA empanelment is expired; new claims are blocked");
  }
  if (empanelment.contractStatus === "suspended") {
    throw new Error("The SHA empanelment is suspended; new claims are blocked");
  }
  if (empanelment.closedAt) {
    throw new Error("The SHA empanelment is closed; new claims are blocked");
  }
  if (empanelment.effectiveFrom > today) {
    throw new Error("The SHA empanelment has not started yet");
  }
  if (empanelment.expiryDate && empanelment.expiryDate < today) {
    throw new Error("The SHA empanelment is expired; new claims are blocked");
  }
  return empanelment;
}

/** KMPDC number and a current active facility licence are both required. */
async function assertLicensedFacility(
  tx: CommandTransaction,
  facilityId: string,
  today = todayIso(),
) {
  const [profile] = await tx
    .select({ kmpdcNumber: facilityRegulatoryProfiles.kmpdcNumber })
    .from(facilityRegulatoryProfiles)
    .where(eq(facilityRegulatoryProfiles.facilityId, facilityId))
    .limit(1);
  if (!profile?.kmpdcNumber?.trim()) {
    throw new Error("A KMPDC number is required before SHA empanelment");
  }
  const [licence] = await tx
    .select({ id: facilityLicences.id })
    .from(facilityLicences)
    .where(
      and(
        eq(facilityLicences.facilityId, facilityId),
        eq(facilityLicences.status, "active"),
        lte(facilityLicences.expiryDate, "9999-12-31"),
        gte(facilityLicences.expiryDate, today),
      ),
    )
    .limit(1);
  if (!licence) {
    throw new Error("An active facility licence is required before SHA empanelment");
  }
  return profile.kmpdcNumber;
}

async function assertAdjudicationCode(
  tx: CommandTransaction,
  facilityId: string,
  code: string,
): Promise<{ code: string; category: string; description: string }> {
  const rows = await tx
    .select({
      code: shaAdjudicationCodes.code,
      category: shaAdjudicationCodes.category,
      description: shaAdjudicationCodes.description,
    })
    .from(shaAdjudicationCodes)
    .where(
      and(
        eq(shaAdjudicationCodes.facilityId, facilityId),
        eq(shaAdjudicationCodes.code, code),
        eq(shaAdjudicationCodes.active, true),
      ),
    )
    .limit(1);
  const adjudicationCode = rows[0];
  if (!adjudicationCode) {
    throw new Error(`SHA adjudication code ${code} is not configured for this facility`);
  }
  return adjudicationCode;
}

/** Split an approved total across lines in proportion to their billed amounts. */
function allocateProRata(approvedCents: number, lines: Array<{ id: string; amount: string }>) {
  const totalCents = lines.reduce((sum, line) => sum + toCents(line.amount), 0);
  if (totalCents <= 0) return lines.map((line) => ({ id: line.id, amount: 0 }));
  let allocated = 0;
  return lines.map((line, index) => {
    const share =
      index === lines.length - 1
        ? approvedCents - allocated
        : Math.round((approvedCents * toCents(line.amount)) / totalCents);
    allocated += share;
    return { id: line.id, amount: Math.max(0, share) };
  });
}

interface ShaLinePricingInput {
  chargeId?: string | null;
  serviceId?: string | null;
  itemId?: string | null;
  shaServiceCode?: string | null;
  description: string;
  amount: string;
  unitPrice?: string | null;
  quantity: string;
  /** Explicit patient-pay lines are never billed to SHA, even when the code is covered. */
  patientPay: boolean;
}

interface PricedShaLine extends ShaLinePricingInput {
  coverage: string;
  billedCents: number;
  coPayCents: number;
  preauthRequired: boolean;
}

type BenefitItem = typeof benefitPackageItems.$inferSelect;
type PreAuthorization = typeof preAuthorizations.$inferSelect;

/**
 * Single pricing engine for claims, co-pay assessments, rework and submission
 * checks. The result is persisted on each claim line so later package edits
 * cannot silently change what was submitted to SHA.
 */
function priceShaLines(
  itemRows: BenefitItem[],
  lines: ShaLinePricingInput[],
  preauth: PreAuthorization | null,
): PricedShaLine[] {
  const prepared = lines.map((line, index) => {
    const amount = fromCents(toCents(line.amount));
    const amountCents = toCents(amount);
    const code = line.shaServiceCode?.trim() || null;
    const item =
      itemRows.find(
        (candidate) =>
          (code && candidate.shaServiceCode === code) ||
          (line.serviceId && candidate.serviceId === line.serviceId) ||
          (line.itemId && candidate.itemId === line.itemId),
      ) ?? null;

    // An explicit patient-pay decision wins over package coverage.
    if (line.patientPay) {
      return {
        ...line,
        amount,
        coverage: "excluded",
        billedCents: 0,
        coPayCents: amountCents,
        preauthRequired: false,
      };
    }

    const coverage = item?.coverage ?? "unlisted";
    if (!item) throw new Error(`Claim line ${index + 1} is not covered by the benefit package`);
    if (coverage === "excluded" || coverage === "unlisted") {
      throw new Error(
        `Claim line ${index + 1} is an excluded benefit; bill it to the patient explicitly`,
      );
    }

    const thresholdCents = item.preauthThreshold ? toCents(item.preauthThreshold) : null;
    const preauthRequired = Boolean(
      item.requiresPreauth || (thresholdCents != null && amountCents > thresholdCents),
    );
    if (preauthRequired && !preauth) {
      throw new Error(`Claim line ${index + 1} needs a pre-authorisation`);
    }
    const coPayPercent = Number(item.coPayPercent);
    const coPayCents = coverage === "partial" ? Math.round((amountCents * coPayPercent) / 100) : 0;
    return {
      ...line,
      amount,
      coverage,
      billedCents: amountCents - coPayCents,
      coPayCents,
      preauthRequired,
    };
  });

  if (preauth?.approvedAmount) {
    const preauthLinesCents = prepared
      .filter((line) => line.preauthRequired)
      .reduce((sum, line) => sum + toCents(line.amount), 0);
    if (preauthLinesCents > toCents(preauth.approvedAmount)) {
      throw new Error("The claim exceeds the approved pre-authorisation amount");
    }
  }
  return prepared;
}

async function assertActiveBenefitPackage(
  tx: CommandTransaction,
  facilityId: string,
  benefitPackageId: string,
  fund: string,
  today = todayIso(),
) {
  const [packageRow] = await tx
    .select()
    .from(benefitPackages)
    .where(
      and(
        eq(benefitPackages.facilityId, facilityId),
        eq(benefitPackages.id, benefitPackageId),
        eq(benefitPackages.fund, fund as "phf"),
        eq(benefitPackages.active, true),
      ),
    )
    .limit(1);
  if (!packageRow) throw new Error("Benefit package not found for this fund");
  if (packageRow.effectiveFrom > today || (packageRow.effectiveTo && packageRow.effectiveTo < today)) {
    throw new Error("The benefit package is not effective on the claim date");
  }
  return packageRow;
}

async function assertValidClaimPreauth(
  tx: CommandTransaction,
  facilityId: string,
  patientId: string,
  fund: string,
  preAuthId: string | null | undefined,
  today = todayIso(),
): Promise<PreAuthorization | null> {
  if (!preAuthId) return null;
  const [row] = await tx
    .select()
    .from(preAuthorizations)
    .where(
      and(
        eq(preAuthorizations.facilityId, facilityId),
        eq(preAuthorizations.id, preAuthId),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.patientId !== patientId ||
    row.fund !== fund ||
    row.status !== "approved"
  ) {
    throw new Error("The pre-authorisation is not approved for this patient and fund");
  }
  if ((row.expiresAt && row.expiresAt < today) || row.shaStatus === "expired") {
    throw new Error("The pre-authorisation has expired");
  }
  return row;
}

function persistedLineInput(
  line: typeof claimLines.$inferSelect,
  amount = line.amount,
): ShaLinePricingInput {
  return {
    chargeId: line.chargeId,
    serviceId: line.serviceId,
    shaServiceCode: line.shaServiceCode,
    description: line.description,
    amount,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    patientPay: line.shaPatientPay,
  };
}

function lineSnapshot(line: PricedShaLine) {
  return {
    shaPatientPay: line.patientPay,
    shaCoverage: line.coverage,
    shaBilledAmount: fromCents(line.billedCents),
    shaPatientAmount: fromCents(line.coPayCents),
    shaPreauthRequired: line.preauthRequired,
  };
}

/* ------------------------------------------------------------------ */
/* Empanelment                                                         */
/* ------------------------------------------------------------------ */

export const createEmpanelmentSchema = z.object({
  ...baseSchema,
  kmpdcNumber: z.string().trim().min(1).max(64),
  fund: z.enum(["phf", "shif", "eccif"]),
  schemeCode: z.string().trim().min(1).max(64),
  schemeName: z.string().trim().max(200).nullable().optional(),
  contractNo: z.string().trim().max(64).nullable().optional(),
  effectiveFrom: isoDate,
  expiryDate: isoDate.nullable().optional(),
  tariffVersion: z.string().trim().max(64).nullable().optional(),
  qualityCertProgram: z.string().trim().max(200).nullable().optional(),
  qualityCertExpiry: isoDate.nullable().optional(),
  bankAccountId: z.uuid().nullable().optional(),
});

export type CreateEmpanelmentInput = z.input<typeof createEmpanelmentSchema>;
export interface EmpanelmentResult {
  empanelmentId: string;
  fund: string;
  schemeCode: string;
  contractStatus: string;
  effectiveFrom: string;
  expiryDate: string | null;
}

export async function createEmpanelment(
  input: CreateEmpanelmentInput,
  options: CommandOptions = {},
): Promise<EmpanelmentResult> {
  const values = createEmpanelmentSchema.parse(input);
  const userId = actorId(values);
  if (values.expiryDate && values.expiryDate < values.effectiveFrom) {
    throw new Error("Empanelment expiry must be on or after the effective date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createEmpanelment",
    async (tx) => {
      const kmpdcNumber = await assertLicensedFacility(tx, values.facilityId);
      const duplicate = await tx
        .select({ id: shaEmpanelments.id })
        .from(shaEmpanelments)
        .where(
          and(
            eq(shaEmpanelments.facilityId, values.facilityId),
            eq(shaEmpanelments.fund, values.fund),
            eq(shaEmpanelments.schemeCode, values.schemeCode),
          ),
        )
        .limit(1);
      if (duplicate[0]) {
        throw new Error(`An empanelment already exists for ${values.fund}/${values.schemeCode}`);
      }

      const empanelmentId = newId();
      await tx.insert(shaEmpanelments).values({
        id: empanelmentId,
        facilityId: values.facilityId,
        kmpdcNumber,
        fund: values.fund,
        schemeCode: values.schemeCode,
        schemeName: values.schemeName?.trim() || null,
        contractNo: values.contractNo?.trim() || null,
        contractStatus: "active",
        effectiveFrom: values.effectiveFrom,
        expiryDate: values.expiryDate ?? null,
        tariffVersion: values.tariffVersion?.trim() || null,
        qualityCertProgram: values.qualityCertProgram?.trim() || null,
        qualityCertExpiry: values.qualityCertExpiry ?? null,
        bankAccountId: values.bankAccountId ?? null,
        createdBy: userId,
      });
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_empanelment.create",
        module: "revenue",
        entity: "sha_empanelments",
        entityId: empanelmentId,
        details: {
          kmpdcNumber,
          fund: values.fund,
          schemeCode: values.schemeCode,
          effectiveFrom: values.effectiveFrom,
          expiryDate: values.expiryDate ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        empanelmentId,
        fund: values.fund,
        schemeCode: values.schemeCode,
        contractStatus: "active",
        effectiveFrom: values.effectiveFrom,
        expiryDate: values.expiryDate ?? null,
      };
    },
    options,
  );
}

export const updateEmpanelmentStatusSchema = z.object({
  ...baseSchema,
  empanelmentId: z.uuid(),
  status: z.enum(["active", "suspended", "expired", "terminated"]),
  reason: z.string().trim().max(500).nullable().optional(),
});

export async function updateEmpanelmentStatus(
  input: z.input<typeof updateEmpanelmentStatusSchema>,
  options: CommandOptions = {},
): Promise<EmpanelmentResult> {
  const values = updateEmpanelmentStatusSchema.parse(input);
  const userId = actorId(values);
  const closing = values.status === "terminated" || values.status === "expired";
  if (closing && !values.reason?.trim()) {
    throw new Error("Closing an empanelment requires a reason");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateEmpanelmentStatus",
    async (tx) => {
      const rows = await tx
        .select()
        .from(shaEmpanelments)
        .where(
          and(
            eq(shaEmpanelments.facilityId, values.facilityId),
            eq(shaEmpanelments.id, values.empanelmentId),
          ),
        )
        .limit(1)
        .for("update");
      const empanelment = rows[0];
      if (!empanelment) throw new Error("SHA empanelment not found in this facility");
      if (empanelment.contractStatus === "terminated") {
        throw new Error("A terminated empanelment cannot be reopened");
      }
      if (empanelment.contractStatus === values.status) {
        throw new Error(`Empanelment is already ${values.status}`);
      }
      if (values.status === "active" && empanelment.closedAt && empanelment.contractStatus !== "suspended") {
        throw new Error("A closed empanelment cannot be reactivated");
      }

      const now = new Date();
      await tx
        .update(shaEmpanelments)
        .set({
          contractStatus: values.status,
          closedAt: closing ? now : empanelment.closedAt,
          closureReason: closing ? values.reason!.trim() : empanelment.closureReason,
          updatedAt: now,
          version: sql`${shaEmpanelments.version} + 1`,
        })
        .where(eq(shaEmpanelments.id, empanelment.id));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_empanelment.status",
        module: "revenue",
        entity: "sha_empanelments",
        entityId: empanelment.id,
        details: {
          from: empanelment.contractStatus,
          to: values.status,
          reason: values.reason ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        empanelmentId: empanelment.id,
        fund: empanelment.fund,
        schemeCode: empanelment.schemeCode,
        contractStatus: values.status,
        effectiveFrom: empanelment.effectiveFrom,
        expiryDate: empanelment.expiryDate,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Benefit packages                                                    */
/* ------------------------------------------------------------------ */

const packageItemSchema = z.object({
  serviceId: z.uuid().nullable().optional(),
  itemId: z.uuid().nullable().optional(),
  shaServiceCode: z.string().trim().max(64).nullable().optional(),
  category: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  coverage: z.enum(["full", "partial", "excluded"]),
  limitAmount: money.nullable().optional(),
  limitDays: z.number().int().nonnegative().nullable().optional(),
  limitVisits: z.number().int().nonnegative().nullable().optional(),
  requiresPreauth: z.boolean().default(false),
  preauthThreshold: money.nullable().optional(),
  coPayPercent: z.number().min(0).max(100).default(0),
  unitPrice: money.default("0"),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const createBenefitPackageSchema = z.object({
  ...baseSchema,
  fund: z.enum(["phf", "shif", "eccif"]),
  packageCode: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  careLevel: z.string().trim().max(64).nullable().optional(),
  careType: z.enum(["inpatient", "outpatient"]),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  items: z.array(packageItemSchema).min(1).max(500),
});

export type CreateBenefitPackageInput = z.input<typeof createBenefitPackageSchema>;
export interface BenefitPackageResult {
  benefitPackageId: string;
  fund: string;
  packageCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  itemCount: number;
}

export async function createBenefitPackage(
  input: CreateBenefitPackageInput,
  options: CommandOptions = {},
): Promise<BenefitPackageResult> {
  const values = createBenefitPackageSchema.parse(input);
  const userId = actorId(values);
  const effectiveTo = values.effectiveTo ?? null;
  if (effectiveTo && effectiveTo < values.effectiveFrom) {
    throw new Error("The benefit package end date must be on or after its start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createBenefitPackage",
    async (tx) => {
      const overlapping = await tx
        .select({ id: benefitPackages.id, effectiveFrom: benefitPackages.effectiveFrom })
        .from(benefitPackages)
        .where(
          and(
            eq(benefitPackages.facilityId, values.facilityId),
            eq(benefitPackages.fund, values.fund),
            eq(benefitPackages.packageCode, values.packageCode),
            lte(benefitPackages.effectiveFrom, effectiveTo ?? "9999-12-31"),
            or(isNull(benefitPackages.effectiveTo), gte(benefitPackages.effectiveTo, values.effectiveFrom)),
          ),
        )
        .limit(1);
      if (overlapping[0]) {
        throw new Error(
          `Benefit package ${values.packageCode} already has an overlapping effective period`,
        );
      }

      const benefitPackageId = newId();
      await tx.insert(benefitPackages).values({
        id: benefitPackageId,
        facilityId: values.facilityId,
        fund: values.fund,
        packageCode: values.packageCode,
        name: values.name,
        careLevel: values.careLevel?.trim() || null,
        careType: values.careType,
        effectiveFrom: values.effectiveFrom,
        effectiveTo,
        active: true,
        createdBy: userId,
      });
      await tx.insert(benefitPackageItems).values(
        values.items.map((item) => ({
          id: newId(),
          facilityId: values.facilityId,
          benefitPackageId,
          serviceId: item.serviceId ?? null,
          itemId: item.itemId ?? null,
          shaServiceCode: item.shaServiceCode?.trim() || null,
          category: item.category?.trim() || null,
          description: item.description?.trim() || null,
          coverage: item.coverage,
          limitAmount: item.limitAmount ?? null,
          limitDays: item.limitDays != null ? String(item.limitDays) : null,
          limitVisits: item.limitVisits != null ? String(item.limitVisits) : null,
          requiresPreauth: item.requiresPreauth,
          preauthThreshold: item.preauthThreshold ?? null,
          coPayPercent: String(item.coPayPercent),
          unitPrice: item.unitPrice,
          notes: item.notes?.trim() || null,
          createdBy: userId,
        })),
      );
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_benefit_package.create",
        module: "revenue",
        entity: "benefit_packages",
        entityId: benefitPackageId,
        details: {
          fund: values.fund,
          packageCode: values.packageCode,
          effectiveFrom: values.effectiveFrom,
          effectiveTo,
          itemCount: values.items.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        benefitPackageId,
        fund: values.fund,
        packageCode: values.packageCode,
        effectiveFrom: values.effectiveFrom,
        effectiveTo,
        itemCount: values.items.length,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Eligibility and waivers                                             */
/* ------------------------------------------------------------------ */

export const verifyShaEligibilitySchema = z.object({
  ...baseSchema,
  patientId: z.uuid(),
  payerId: z.uuid().nullable().optional(),
  empanelmentId: z.uuid().nullable().optional(),
  fund: z.enum(["phf", "shif", "eccif"]).nullable().optional(),
  memberRef: z.string().trim().max(64).nullable().optional(),
  eligibility: z.enum(["eligible", "ineligible", "unknown"]),
  checkRef: z.string().trim().max(64).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  checkedAt: z.coerce.date().optional(),
});

export interface EligibilityResult {
  checkId: string;
  patientId: string;
  eligibility: string;
  checkRef: string | null;
  checkedAt: string;
}

export async function verifyShaEligibility(
  input: z.input<typeof verifyShaEligibilitySchema>,
  options: CommandOptions = {},
): Promise<EligibilityResult> {
  const values = verifyShaEligibilitySchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "verifyShaEligibility",
    async (tx) => {
      const [patient] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.facilityId, values.facilityId), eq(patients.id, values.patientId)))
        .limit(1);
      if (!patient) throw new Error("Patient not found in this facility");

      const checkId = newId();
      const checkedAt = values.checkedAt ?? new Date();
      await tx.insert(shaEligibilityChecks).values({
        id: checkId,
        facilityId: values.facilityId,
        patientId: values.patientId,
        payerId: values.payerId ?? null,
        empanelmentId: values.empanelmentId ?? null,
        fund: values.fund ?? null,
        memberRef: values.memberRef?.trim() || null,
        eligibility: values.eligibility,
        checkRef: values.checkRef?.trim() || null,
        checkedAt,
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_eligibility.verify",
        module: "revenue",
        entity: "sha_eligibility_checks",
        entityId: checkId,
        details: {
          patientId: values.patientId,
          payerId: values.payerId ?? null,
          fund: values.fund ?? null,
          eligibility: values.eligibility,
          memberRef: values.memberRef ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        checkId,
        patientId: values.patientId,
        eligibility: values.eligibility,
        checkRef: values.checkRef?.trim() || null,
        checkedAt: checkedAt.toISOString(),
      };
    },
    options,
  );
}

export const recordShaCoPaySchema = z.object({
  ...baseSchema,
  patientId: z.uuid(),
  encounterId: z.uuid(),
  invoiceId: z.uuid(),
  empanelmentId: z.uuid(),
  benefitPackageId: z.uuid(),
  eligibilityCheckId: z.uuid().nullable().optional(),
  payerId: z.uuid().nullable().optional(),
  fund: z.enum(["phf", "shif", "eccif"]),
  notes: z.string().trim().max(500).nullable().optional(),
  lines: z.array(shaClaimLineSchema).min(1).max(100),
});

export interface ShaCoPayResult {
  assessmentId: string;
  amount: string;
  eligibilityCheckId: string;
  lineCount: number;
  lines: Array<{
    description: string;
    shaServiceCode: string | null;
    coverage: string;
    billed: string;
    patientCoPay: string;
    preauthRequired: boolean;
  }>;
}

/** Cashier-authored co-pay assessment, retained as evidence before the claim exists. */
export async function recordShaCoPay(
  input: z.input<typeof recordShaCoPaySchema>,
  options: CommandOptions = {},
): Promise<ShaCoPayResult> {
  const values = recordShaCoPaySchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordShaCoPay",
    async (tx) => {
      const [patient] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.facilityId, values.facilityId), eq(patients.id, values.patientId)))
        .limit(1);
      if (!patient) throw new Error("Patient not found in this facility");

      const [encounter] = await tx
        .select({ id: encounters.id, patientId: encounters.patientId })
        .from(encounters)
        .where(
          and(eq(encounters.facilityId, values.facilityId), eq(encounters.id, values.encounterId)),
        )
        .limit(1);
      if (!encounter) throw new Error("Encounter not found in this facility");
      if (encounter.patientId !== values.patientId) {
        throw new Error("The encounter belongs to a different patient");
      }

      const [invoice] = await tx
        .select({ id: invoices.id, encounterId: invoices.encounterId, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.facilityId, values.facilityId), eq(invoices.id, values.invoiceId)))
        .limit(1);
      if (!invoice) throw new Error("Invoice not found in this facility");
      if (invoice.encounterId !== encounter.id) {
        throw new Error("The invoice belongs to a different encounter");
      }
      if (invoice.status === "void") throw new Error("A void invoice cannot be assessed");

      await assertActiveEmpanelment(
        tx,
        values.facilityId,
        values.empanelmentId,
        values.fund,
      );
      const benefitPackage = await assertActiveBenefitPackage(
        tx,
        values.facilityId,
        values.benefitPackageId,
        values.fund,
      );

      let eligibilityCheckId = values.eligibilityCheckId ?? null;
      if (eligibilityCheckId) {
        const [check] = await tx
          .select({ id: shaEligibilityChecks.id, eligibility: shaEligibilityChecks.eligibility })
          .from(shaEligibilityChecks)
          .where(
            and(
              eq(shaEligibilityChecks.facilityId, values.facilityId),
              eq(shaEligibilityChecks.id, eligibilityCheckId),
              eq(shaEligibilityChecks.patientId, values.patientId),
            ),
          )
          .limit(1);
        if (!check || check.eligibility !== "eligible") {
          throw new Error("Select an eligible SHA check for this patient before recording a co-pay");
        }
      } else {
        const [check] = await tx
          .select({ id: shaEligibilityChecks.id })
          .from(shaEligibilityChecks)
          .where(
            and(
              eq(shaEligibilityChecks.facilityId, values.facilityId),
              eq(shaEligibilityChecks.patientId, values.patientId),
              eq(shaEligibilityChecks.eligibility, "eligible"),
            ),
          )
          .orderBy(desc(shaEligibilityChecks.checkedAt))
          .limit(1);
        if (!check) throw new Error("Verify SHA eligibility before recording a co-pay");
        eligibilityCheckId = check.id;
      }

      const itemRows = await tx
        .select()
        .from(benefitPackageItems)
        .where(
          and(
            eq(benefitPackageItems.facilityId, values.facilityId),
            eq(benefitPackageItems.benefitPackageId, benefitPackage.id),
          ),
        );
      const priced = priceShaLines(
        itemRows,
        values.lines.map((line) => ({
          chargeId: line.chargeId ?? null,
          serviceId: line.serviceId ?? null,
          itemId: line.itemId ?? null,
          shaServiceCode: line.shaServiceCode ?? null,
          description: line.description,
          amount: line.amount,
          unitPrice: line.unitPrice ?? null,
          quantity: String(line.quantity),
          patientPay: line.patientPay,
        })),
        null,
      );
      const patientCents = priced.reduce((sum, line) => sum + line.coPayCents, 0);
      const amount = fromCents(patientCents);
      const assessmentId = newId();
      const assessmentLines = priced.map((line) => ({
        description: line.description,
        shaServiceCode: line.shaServiceCode?.trim() || null,
        coverage: line.coverage,
        billed: fromCents(line.billedCents),
        patientCoPay: fromCents(line.coPayCents),
        preauthRequired: line.preauthRequired,
      }));

      await tx.insert(shaCoPayAssessments).values({
        id: assessmentId,
        facilityId: values.facilityId,
        patientId: values.patientId,
        encounterId: encounter.id,
        invoiceId: invoice.id,
        empanelmentId: values.empanelmentId,
        benefitPackageId: benefitPackage.id,
        eligibilityCheckId,
        payerId: values.payerId ?? null,
        fund: values.fund,
        amount,
        lines: assessmentLines,
        notes: values.notes?.trim() || null,
        recordedBy: userId,
        createdBy: userId,
      });
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_co_pay.record",
        module: "revenue",
        entity: "sha_co_pay_assessments",
        entityId: assessmentId,
        details: {
          patientId: values.patientId,
          invoiceId: invoice.id,
          empanelmentId: values.empanelmentId,
          benefitPackageId: benefitPackage.id,
          eligibilityCheckId,
          amount,
          lineCount: priced.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        assessmentId,
        amount,
        eligibilityCheckId: eligibilityCheckId!,
        lineCount: priced.length,
        lines: assessmentLines,
      };
    },
    options,
  );
}

export const requestShaWaiverSchema = z.object({
  ...baseSchema,
  kind: z.enum(["waiver", "exemption"]).default("waiver"),
  claimId: z.uuid().nullable().optional(),
  invoiceId: z.uuid().nullable().optional(),
  amount: positiveMoney,
  reason: z.string().trim().min(1, "A waiver reason is required").max(500),
});

export interface WaiverResult {
  waiverId: string;
  kind: string;
  amount: string;
  status: string;
  reason: string;
  approvedBy: string | null;
}

export async function requestShaWaiver(
  input: z.input<typeof requestShaWaiverSchema>,
  options: CommandOptions = {},
): Promise<WaiverResult> {
  const values = requestShaWaiverSchema.parse(input);
  const userId = actorId(values);
  if (!values.claimId && !values.invoiceId) {
    throw new Error("A waiver must link to a claim or an invoice");
  }
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "requestShaWaiver",
    async (tx) => {
      const waiverId = newId();
      await tx.insert(shaWaivers).values({
        id: waiverId,
        facilityId: values.facilityId,
        kind: values.kind,
        claimId: values.claimId ?? null,
        invoiceId: values.invoiceId ?? null,
        amount: values.amount,
        reason: values.reason,
        requestedBy: userId,
        status: "requested",
        createdBy: userId,
      });
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_waiver.request",
        module: "revenue",
        entity: "sha_waivers",
        entityId: waiverId,
        details: { kind: values.kind, amount: values.amount, reason: values.reason },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        waiverId,
        kind: values.kind,
        amount: values.amount,
        status: "requested",
        reason: values.reason,
        approvedBy: null,
      };
    },
    options,
  );
}

const decideWaiverSchema = z.object({
  ...baseSchema,
  waiverId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).nullable().optional(),
});

async function decideShaWaiver(
  input: z.input<typeof decideWaiverSchema>,
  kind: "waiver" | "exemption",
  commandName: string,
  options: CommandOptions,
): Promise<WaiverResult> {
  const values = decideWaiverSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    commandName,
    async (tx) => {
      const rows = await tx
        .select()
        .from(shaWaivers)
        .where(and(eq(shaWaivers.facilityId, values.facilityId), eq(shaWaivers.id, values.waiverId)))
        .limit(1)
        .for("update");
      const waiver = rows[0];
      if (!waiver) throw new Error("SHA waiver not found in this facility");
      if (waiver.kind !== kind) throw new Error(`This request is not a ${kind}`);
      if (waiver.status !== "requested") throw new Error(`This waiver is already ${waiver.status}`);
      if (!waiver.reason?.trim()) throw new Error("A waiver requires a reason");
      assertDifferentActor(userId, waiver.requestedBy, "The requester cannot approve their own waiver");

      await tx
        .update(shaWaivers)
        .set({
          status: values.decision,
          approvedBy: values.decision === "approved" ? userId : null,
          decidedAt: new Date(),
        })
        .where(eq(shaWaivers.id, waiver.id));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: `sha_waiver.${values.decision}`,
        module: "revenue",
        entity: "sha_waivers",
        entityId: waiver.id,
        details: { kind, decision: values.decision, note: values.note ?? null },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        waiverId: waiver.id,
        kind,
        amount: waiver.amount,
        status: values.decision,
        reason: waiver.reason,
        approvedBy: values.decision === "approved" ? userId : null,
      };
    },
    options,
  );
}

export function approveWaiver(
  input: z.input<typeof decideWaiverSchema>,
  options: CommandOptions = {},
): Promise<WaiverResult> {
  return decideShaWaiver(input, "waiver", "approveWaiver", options);
}

export function approveExemption(
  input: z.input<typeof decideWaiverSchema>,
  options: CommandOptions = {},
): Promise<WaiverResult> {
  return decideShaWaiver(input, "exemption", "approveExemption", options);
}

/* ------------------------------------------------------------------ */
/* Pre-authorisation                                                   */
/* ------------------------------------------------------------------ */

export const requestShaPreAuthorizationSchema = z.object({
  ...baseSchema,
  payerId: z.uuid(),
  contractId: z.uuid().nullable().optional(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable().optional(),
  empanelmentId: z.uuid(),
  benefitPackageId: z.uuid().nullable().optional(),
  fund: z.enum(["phf", "shif", "eccif"]),
  requestedAmount: positiveMoney,
  shaAuthRef: z.string().trim().max(64).nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export interface ShaPreAuthResult {
  preAuthId: string;
  authNo: string;
  status: string;
  fund: string;
  requestedAmount: string;
}

export async function requestShaPreAuthorization(
  input: z.input<typeof requestShaPreAuthorizationSchema>,
  options: CommandOptions = {},
): Promise<ShaPreAuthResult> {
  const values = requestShaPreAuthorizationSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "requestShaPreAuthorization",
    async (tx) => {
      await assertActiveEmpanelment(tx, values.facilityId, values.empanelmentId, values.fund);
      const [payer] = await tx
        .select({ id: payers.id })
        .from(payers)
        .where(and(eq(payers.facilityId, values.facilityId), eq(payers.id, values.payerId)))
        .limit(1);
      if (!payer) throw new Error("Payer not found in this facility");
      const facility = await loadFacility(tx, values.facilityId);
      const authNo = await nextFormattedNumber(tx, facility, "preauth");
      const preAuthId = newId();
      await tx.insert(preAuthorizations).values({
        id: preAuthId,
        facilityId: values.facilityId,
        payerId: payer.id,
        contractId: values.contractId ?? null,
        patientId: values.patientId,
        encounterId: values.encounterId ?? null,
        authNo,
        shaAuthRef: values.shaAuthRef?.trim() || null,
        fund: values.fund,
        benefitPackageId: values.benefitPackageId ?? null,
        shaStatus: "requested",
        requestedAmount: values.requestedAmount,
        status: "requested",
        expiresAt: values.expiresAt ?? null,
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_preauth.request",
        module: "revenue",
        entity: "pre_authorizations",
        entityId: preAuthId,
        details: { authNo, fund: values.fund, requestedAmount: values.requestedAmount },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        preAuthId,
        authNo,
        status: "requested",
        fund: values.fund,
        requestedAmount: values.requestedAmount,
      };
    },
    options,
  );
}

export const decideShaPreAuthorizationSchema = z.object({
  ...baseSchema,
  preAuthId: z.uuid(),
  decision: z.enum(["approved", "declined"]),
  approvedAmount: money.nullable().optional(),
  shaAuthRef: z.string().trim().max(64).nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function decideShaPreAuthorization(
  input: z.input<typeof decideShaPreAuthorizationSchema>,
  options: CommandOptions = {},
): Promise<ShaPreAuthResult> {
  const values = decideShaPreAuthorizationSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "decideShaPreAuthorization",
    async (tx) => {
      const rows = await tx
        .select()
        .from(preAuthorizations)
        .where(
          and(
            eq(preAuthorizations.facilityId, values.facilityId),
            eq(preAuthorizations.id, values.preAuthId),
          ),
        )
        .limit(1)
        .for("update");
      const auth = rows[0];
      if (!auth) throw new Error("SHA pre-authorisation not found in this facility");
      if (auth.status !== "requested") throw new Error(`This pre-authorisation is already ${auth.status}`);
      assertDifferentActor(userId, auth.createdBy, "The requester cannot decide their own authorisation");
      if (values.decision === "approved" && toCents(values.approvedAmount ?? 0) <= 0) {
        throw new Error("An approved authorisation needs an approved amount");
      }
      const now = new Date();
      await tx
        .update(preAuthorizations)
        .set({
          status: values.decision,
          shaStatus: values.decision,
          approvedAmount: values.decision === "approved" ? (values.approvedAmount ?? null) : null,
          shaAuthRef: values.shaAuthRef?.trim() || auth.shaAuthRef,
          expiresAt: values.expiresAt ?? auth.expiresAt,
          notes: values.note?.trim() || auth.notes,
          decidedAt: now,
          decidedBy: userId,
          updatedAt: now,
          version: sql`${preAuthorizations.version} + 1`,
        })
        .where(eq(preAuthorizations.id, auth.id));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_preauth.decide",
        module: "revenue",
        entity: "pre_authorizations",
        entityId: auth.id,
        details: { authNo: auth.authNo, decision: values.decision },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        preAuthId: auth.id,
        authNo: auth.authNo,
        status: values.decision,
        fund: auth.fund ?? "",
        requestedAmount: auth.requestedAmount,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export const createShaClaimSchema = z.object({
  ...baseSchema,
  payerId: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid(),
  invoiceId: z.uuid(),
  empanelmentId: z.uuid(),
  benefitPackageId: z.uuid(),
  fund: z.enum(["phf", "shif", "eccif"]),
  preAuthId: z.uuid().nullable().optional(),
  coPayAssessmentId: z.uuid().nullable().optional(),
  sharingAgreementId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(shaClaimLineSchema).min(1).max(100),
});

export interface ShaClaimResult {
  claimId: string;
  claimNo: string;
  status: string;
  total: string;
  billedAmount: string;
  patientCoPay: string;
  lineCount: number;
  coverage: Array<{
    description: string;
    shaServiceCode: string | null;
    coverage: string;
    billed: string;
    patientCoPay: string;
    preauthRequired: boolean;
  }>;
}

export async function createShaClaim(
  input: z.input<typeof createShaClaimSchema>,
  options: CommandOptions = {},
): Promise<ShaClaimResult> {
  const values = createShaClaimSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createShaClaim",
    async (tx) => {
      // The guard runs inside the idempotency work callback: a replay returns
      // the stored result without re-running it, while refusals still audit on
      // the default connection because the command transaction rolls back.
      await assertFacilityReady(
        { facilityId: values.facilityId, action: "claiming", actor: values.actor },
        options,
      );
      const today = todayIso();
      const empanelment = await assertActiveEmpanelment(
        tx,
        values.facilityId,
        values.empanelmentId,
        values.fund,
        today,
      );

      const packageRow = await assertActiveBenefitPackage(
        tx,
        values.facilityId,
        values.benefitPackageId,
        values.fund,
        today,
      );

      const [payer] = await tx
        .select({ id: payers.id })
        .from(payers)
        .where(and(eq(payers.facilityId, values.facilityId), eq(payers.id, values.payerId)))
        .limit(1);
      if (!payer) throw new Error("Payer not found in this facility");

      const [encounter] = await tx
        .select({ id: encounters.id, patientId: encounters.patientId })
        .from(encounters)
        .where(
          and(
            eq(encounters.facilityId, values.facilityId),
            eq(encounters.id, values.encounterId),
          ),
        )
        .limit(1)
        .for("update");
      if (!encounter) throw new Error("Encounter not found in this facility");
      if (encounter.patientId !== values.patientId) {
        throw new Error("The encounter belongs to a different patient");
      }

      const [invoice] = await tx
        .select({
          id: invoices.id,
          encounterId: invoices.encounterId,
          status: invoices.status,
          isShaClaimable: invoices.isShaClaimable,
        })
        .from(invoices)
        .where(and(eq(invoices.facilityId, values.facilityId), eq(invoices.id, values.invoiceId)))
        .limit(1);
      if (!invoice) throw new Error("Invoice not found in this facility");
      if (invoice.encounterId !== encounter.id) {
        throw new Error("The invoice belongs to a different encounter");
      }
      if (invoice.status === "void") throw new Error("A void invoice cannot be claimed");
      if (!invoice.isShaClaimable) {
        throw new Error("The invoice is not marked as SHA claimable");
      }

      await assertValidPayerSharingConsent(tx, {
        facilityId: values.facilityId,
        patientId: values.patientId,
        actor: values.actor,
        action: "revenue.claim.create_refused",
        entity: "claims",
        entityId: null,
        details: { payerId: payer.id, encounterId: encounter.id, invoiceId: invoice.id },
        sharingAgreementId: values.sharingAgreementId ?? null,
      });

      const preauth = await assertValidClaimPreauth(
        tx,
        values.facilityId,
        values.patientId,
        values.fund,
        values.preAuthId,
        today,
      );

      const itemRows = await tx
        .select()
        .from(benefitPackageItems)
        .where(
          and(
            eq(benefitPackageItems.facilityId, values.facilityId),
            eq(benefitPackageItems.benefitPackageId, values.benefitPackageId),
          ),
        );
      if (values.coPayAssessmentId) {
        const [assessment] = await tx
          .select({ id: shaCoPayAssessments.id })
          .from(shaCoPayAssessments)
          .where(
            and(
              eq(shaCoPayAssessments.facilityId, values.facilityId),
              eq(shaCoPayAssessments.id, values.coPayAssessmentId),
              eq(shaCoPayAssessments.patientId, values.patientId),
              eq(shaCoPayAssessments.encounterId, values.encounterId),
              eq(shaCoPayAssessments.invoiceId, values.invoiceId),
              eq(shaCoPayAssessments.benefitPackageId, values.benefitPackageId),
            ),
          )
          .limit(1);
        if (!assessment) {
          throw new Error("The co-pay assessment does not match this patient, encounter and package");
        }
      }

      const prepared = priceShaLines(
        itemRows,
        values.lines.map((line) => ({
          chargeId: line.chargeId ?? null,
          serviceId: line.serviceId ?? null,
          itemId: line.itemId ?? null,
          shaServiceCode: line.shaServiceCode ?? null,
          description: line.description,
          amount: line.amount,
          unitPrice: line.unitPrice ?? null,
          quantity: String(line.quantity),
          patientPay: line.patientPay,
        })),
        preauth,
      );

      const totalCents = prepared.reduce((sum, line) => sum + toCents(line.amount), 0);
      const billedCents = prepared.reduce((sum, line) => sum + line.billedCents, 0);
      const coPayCents = prepared.reduce((sum, line) => sum + line.coPayCents, 0);
      if (totalCents <= 0) throw new Error("A claim total must be greater than zero");
      if (billedCents + coPayCents !== totalCents) {
        throw new Error("Claim lines do not reconcile to the claim total");
      }

      const facility = await loadFacility(tx, values.facilityId);
      const claimNo = await nextFormattedNumber(tx, facility, "claim");
      const claimId = newId();
      const total = fromCents(totalCents);
      const billedAmount = fromCents(billedCents);
      const patientCoPay = fromCents(coPayCents);
      if (toCents(total) !== totalCents) throw new Error("Claim amount failed cent reconciliation");

      await tx.insert(claims).values({
        id: claimId,
        facilityId: values.facilityId,
        payerId: payer.id,
        patientId: values.patientId,
        encounterId: encounter.id,
        invoiceId: invoice.id,
        claimNo,
        status: "draft",
        fund: values.fund,
        empanelmentId: empanelment.id,
        benefitPackageId: packageRow.id,
        preAuthId: preauth?.id ?? null,
        coPayAssessmentId: values.coPayAssessmentId ?? null,
        tariffVersion: empanelment.tariffVersion,
        billedAmount,
        patientCoPay,
        total,
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });
      await tx.insert(claimLines).values(
        prepared.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          claimId,
          chargeId: line.chargeId ?? null,
          serviceId: line.serviceId ?? null,
          description: line.description,
          amount: line.amount,
          shaServiceCode: line.shaServiceCode?.trim() || null,
          unitPrice: line.unitPrice ?? line.amount,
          quantity: line.quantity,
          approvedAmount: "0",
          ...lineSnapshot(line),
        })),
      );
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_claim.create",
        module: "revenue",
        entity: "claims",
        entityId: claimId,
        details: {
          claimNo,
          fund: values.fund,
          empanelmentId: empanelment.id,
          benefitPackageId: packageRow.id,
          preAuthId: preauth?.id ?? null,
          coPayAssessmentId: values.coPayAssessmentId ?? null,
          invoiceId: invoice.id,
          encounterId: encounter.id,
          total,
          billedAmount,
          patientCoPay,
          lineCount: prepared.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "sha.claim.created",
        facilityId: values.facilityId,
        claimId,
        claimNo,
        total,
      });

      return {
        claimId,
        claimNo,
        status: "draft",
        total,
        billedAmount,
        patientCoPay,
        lineCount: prepared.length,
        coverage: prepared.map((line) => ({
          description: line.description,
          shaServiceCode: line.shaServiceCode?.trim() || null,
          coverage: line.coverage,
          billed: fromCents(line.billedCents),
          patientCoPay: fromCents(line.coPayCents),
          preauthRequired: line.preauthRequired,
        })),
      };
    },
    options,
  );
}

/**
 * A draft is locked to the pricing snapshot taken at creation. If the tariff,
 * coverage, co-pay or linked authorisation changed while it was a draft, the
 * preparer must rework it rather than silently submitting stale figures.
 */
async function assertClaimPricingSnapshot(
  tx: CommandTransaction,
  facilityId: string,
  claim: typeof claims.$inferSelect,
  lineRows: Array<typeof claimLines.$inferSelect>,
  today = todayIso(),
) {
  if (!claim.fund || !claim.benefitPackageId) return;
  const packageRow = await assertActiveBenefitPackage(
    tx,
    facilityId,
    claim.benefitPackageId,
    claim.fund,
    today,
  );
  const preauth = await assertValidClaimPreauth(
    tx,
    facilityId,
    claim.patientId,
    claim.fund,
    claim.preAuthId,
    today,
  );
  const itemRows = await tx
    .select()
    .from(benefitPackageItems)
    .where(
      and(
        eq(benefitPackageItems.facilityId, facilityId),
        eq(benefitPackageItems.benefitPackageId, packageRow.id),
      ),
    );
  const priced = priceShaLines(
    itemRows,
    lineRows.map((line) => persistedLineInput(line)),
    preauth,
  );
  if (priced.length !== lineRows.length) {
    throw new Error("The claim line snapshot is incomplete; rework the claim before submission");
  }

  for (const [index, expected] of priced.entries()) {
    const line = lineRows[index];
    const matches =
      line.shaCoverage === expected.coverage &&
      line.shaPatientPay === expected.patientPay &&
      toCents(line.shaBilledAmount) === expected.billedCents &&
      toCents(line.shaPatientAmount) === expected.coPayCents &&
      line.shaPreauthRequired === expected.preauthRequired &&
      toCents(line.amount) === toCents(expected.amount);
    if (!matches) {
      throw new Error(
        `Claim line ${index + 1} no longer matches the active benefit package; rework the claim before submission`,
      );
    }
  }

  const totalCents = priced.reduce((sum, line) => sum + toCents(line.amount), 0);
  const billedCents = priced.reduce((sum, line) => sum + line.billedCents, 0);
  const coPayCents = priced.reduce((sum, line) => sum + line.coPayCents, 0);
  if (
    toCents(claim.total) !== totalCents ||
    toCents(claim.billedAmount) !== billedCents ||
    toCents(claim.patientCoPay) !== coPayCents
  ) {
    throw new Error("The claim totals no longer match its line snapshot; rework the claim before submission");
  }
}

export const submitShaClaimSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  submissionBatch: z.string().trim().max(64).nullable().optional(),
});

export interface SubmitShaClaimResult {
  claimId: string;
  claimNo: string;
  shaClaimRef: string;
  submissionBatch: string;
  status: string;
  submittedAt: string;
  journalEntryNo: string | null;
}

export async function submitShaClaim(
  input: z.input<typeof submitShaClaimSchema>,
  options: CommandOptions = {},
): Promise<SubmitShaClaimResult> {
  const values = submitShaClaimSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "submitShaClaim",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      if (claim.status !== "draft") throw new Error("Only a draft SHA claim can be submitted");
      assertDifferentActor(userId, claim.createdBy, "The claim preparer cannot submit this claim");
      if (claim.fund) await assertActiveEmpanelment(tx, values.facilityId, claim.empanelmentId!, claim.fund);
      const lineRows = await tx
        .select()
        .from(claimLines)
        .where(and(eq(claimLines.facilityId, values.facilityId), eq(claimLines.claimId, claim.id)));
      if (lineRows.length === 0) throw new Error("The claim has no lines");
      await assertClaimPricingSnapshot(tx, values.facilityId, claim, lineRows);

      const now = new Date();
      const shaClaimRef = claim.shaClaimRef ?? `SHA-${claim.claimNo}`;
      const submissionBatch =
        values.submissionBatch?.trim() || `BATCH-${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
      await tx
        .update(claims)
        .set({
          status: "submitted",
          shaClaimRef,
          submissionBatch,
          submittedAt: now,
          submittedBy: userId,
          updatedAt: now,
          version: sql`${claims.version} + 1`,
        })
        .where(eq(claims.id, claim.id));

      let journal = null;
      if (claim.invoiceId && toCents(claim.billedAmount) > 0) {
        // Submission moves the billed debt from the patient to the fund.
        journal = await tryPostJournal(tx, {
          facilityId: values.facilityId,
          entryDate: now.toISOString().slice(0, 10),
          description: `SHA claim ${claim.claimNo} submitted`,
          sourceType: "sha_claim_submission",
          sourceId: claim.id,
          userId,
          ip: values.actor.ip,
          deviceId: values.actor.deviceId,
          lines: [
            {
              systemRole: "insurance_receivable",
              debit: claim.billedAmount,
              description: `SHA claim ${claim.claimNo}`,
            },
            {
              systemRole: "patient_receivable",
              credit: claim.billedAmount,
              description: `Reclassify invoice for ${claim.claimNo}`,
            },
          ],
        });
      }
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_claim.submit",
        module: "revenue",
        entity: "claims",
        entityId: claim.id,
        details: { claimNo: claim.claimNo, shaClaimRef, submissionBatch },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "sha.claim.submitted",
        facilityId: values.facilityId,
        claimId: claim.id,
        shaClaimRef,
      });
      return {
        claimId: claim.id,
        claimNo: claim.claimNo,
        shaClaimRef,
        submissionBatch,
        status: "submitted",
        submittedAt: now.toISOString(),
        journalEntryNo: journal?.entryNo ?? null,
      };
    },
    options,
  );
}

export const recordShaAdjudicationSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  code: z.string().trim().min(1).max(32),
  approvedAmount: money.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export interface ShaAdjudicationResult {
  claimId: string;
  claimNo: string;
  status: string;
  approvedAmount: string;
  adjudicationCode: string;
  category: string;
}

export async function recordShaAdjudication(
  input: z.input<typeof recordShaAdjudicationSchema>,
  options: CommandOptions = {},
): Promise<ShaAdjudicationResult> {
  const values = recordShaAdjudicationSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordShaAdjudication",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      if (claim.status !== "submitted" && claim.status !== "resubmitted") {
        throw new Error("Only a submitted SHA claim can be adjudicated");
      }
      assertDifferentActor(userId, claim.createdBy, "The claim preparer cannot adjudicate this claim");
      assertDifferentActor(userId, claim.submittedBy, "The claim submitter cannot adjudicate this claim");
      const adjudicationCode = await assertAdjudicationCode(tx, values.facilityId, values.code);

      if (adjudicationCode.category === "rejected") {
        throw new Error("Use recordShaDenial for a rejected adjudication");
      }
      const status: ClaimStatus = adjudicationCode.category === "info" ? "queried" : "accepted";
      assertClaimTransition(claim.status, status);
      const approvedAmount =
        status === "accepted"
          ? (values.approvedAmount ?? claim.billedAmount)
          : claim.approvedAmount;
      if (status === "accepted" && toCents(approvedAmount) <= 0) {
        throw new Error("An accepted SHA claim needs an approved amount");
      }

      const now = new Date();
      await tx
        .update(claims)
        .set({
          status,
          approvedAmount,
          adjudicationStatus: adjudicationCode.category,
          adjudicationCode: adjudicationCode.code,
          approvedAt: status === "accepted" ? now : claim.approvedAt,
          approvedBy: status === "accepted" ? userId : claim.approvedBy,
          notes: values.note?.trim() || claim.notes,
          updatedAt: now,
          version: sql`${claims.version} + 1`,
        })
        .where(eq(claims.id, claim.id));

      if (status === "accepted") {
        const lineRows = await tx
          .select({
            id: claimLines.id,
            amount: claimLines.shaBilledAmount,
            patientPay: claimLines.shaPatientPay,
          })
          .from(claimLines)
          .where(eq(claimLines.claimId, claim.id));
        const billableLines = lineRows
          .filter((line) => !line.patientPay && toCents(line.amount) > 0)
          .map((line) => ({ id: line.id, amount: line.amount }));
        if (billableLines.length === 0) {
          throw new Error("An accepted SHA claim needs at least one SHA-billable line");
        }
        for (const line of lineRows.filter((row) => row.patientPay)) {
          await tx
            .update(claimLines)
            .set({ approvedAmount: "0" })
            .where(eq(claimLines.id, line.id));
        }
        for (const allocation of allocateProRata(toCents(approvedAmount), billableLines)) {
          await tx
            .update(claimLines)
            .set({ approvedAmount: fromCents(allocation.amount) })
            .where(eq(claimLines.id, allocation.id));
        }
      }
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_claim.adjudicate",
        module: "revenue",
        entity: "claims",
        entityId: claim.id,
        details: {
          claimNo: claim.claimNo,
          code: adjudicationCode.code,
          category: adjudicationCode.category,
          approvedAmount,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        claimId: claim.id,
        claimNo: claim.claimNo,
        status,
        approvedAmount,
        adjudicationCode: adjudicationCode.code,
        category: adjudicationCode.category,
      };
    },
    options,
  );
}

export const recordShaDenialSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  code: z.string().trim().min(1).max(32),
  reason: z.string().trim().min(1, "A denial reason is required").max(500),
  claimLineId: z.uuid().nullable().optional(),
  amount: money.nullable().optional(),
});

export interface ShaDenialResult {
  denialId: string;
  claimId: string;
  code: string;
  reason: string;
  amount: string;
  status: string;
}

export async function recordShaDenial(
  input: z.input<typeof recordShaDenialSchema>,
  options: CommandOptions = {},
): Promise<ShaDenialResult> {
  const values = recordShaDenialSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordShaDenial",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      if (claim.status !== "submitted" && claim.status !== "resubmitted" && claim.status !== "queried") {
        throw new Error("Only a submitted SHA claim can be denied");
      }
      const adjudicationCode = await assertAdjudicationCode(tx, values.facilityId, values.code);
      if (adjudicationCode.category !== "rejected") {
        throw new Error(`Adjudication code ${values.code} is not a rejection code`);
      }
      const amount = values.amount ?? claim.billedAmount;
      const denialId = newId();
      await tx.insert(claimDenials).values({
        id: denialId,
        facilityId: values.facilityId,
        claimId: claim.id,
        claimLineId: values.claimLineId ?? null,
        amount,
        reason: values.reason,
        shaDenialCode: adjudicationCode.code,
        adjudicationReason: adjudicationCode.description,
        status: "open",
      });
      if (values.claimLineId) {
        await tx
          .update(claimLines)
          .set({ denialCode: adjudicationCode.code, denialReason: values.reason })
          .where(eq(claimLines.id, values.claimLineId));
      }
      await tx
        .update(claims)
        .set({
          status: "rejected",
          adjudicationStatus: "rejected",
          adjudicationCode: adjudicationCode.code,
          updatedAt: new Date(),
          version: sql`${claims.version} + 1`,
        })
        .where(eq(claims.id, claim.id));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_claim.denied",
        module: "revenue",
        entity: "claim_denials",
        entityId: denialId,
        details: {
          claimNo: claim.claimNo,
          code: adjudicationCode.code,
          reason: values.reason,
          amount,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        denialId,
        claimId: claim.id,
        code: adjudicationCode.code,
        reason: values.reason,
        amount,
        status: "open",
      };
    },
    options,
  );
}

const reworkLineSchema = z.object({
  claimLineId: z.uuid(),
  amount: positiveMoney.optional(),
});

export const reworkShaClaimSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  denialId: z.uuid().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  lineAdjustments: z.array(reworkLineSchema).max(100).optional(),
});

export interface ReworkResult {
  claimId: string;
  claimNo: string;
  shaClaimRef: string | null;
  status: string;
  supersedesClaimId: string;
  denialReason: string | null;
  lineCount: number;
}

export async function reworkShaClaim(
  input: z.input<typeof reworkShaClaimSchema>,
  options: CommandOptions = {},
): Promise<ReworkResult> {
  const values = reworkShaClaimSchema.parse(input);
  const userId = actorId(values);
  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "reworkShaClaim",
    async (tx) => {
      const original = await loadClaim(tx, values.facilityId, values.claimId);
      if (original.status !== "rejected") throw new Error("Only a denied SHA claim can be reworked");
      if (!original.fund || !original.empanelmentId || !original.benefitPackageId) {
        throw new Error("The original claim is not a SHA claim");
      }
      const empanelment = await assertActiveEmpanelment(
        tx,
        values.facilityId,
        original.empanelmentId,
        original.fund,
      );
      const packageRow = await assertActiveBenefitPackage(
        tx,
        values.facilityId,
        original.benefitPackageId,
        original.fund,
      );
      const preauth = await assertValidClaimPreauth(
        tx,
        values.facilityId,
        original.patientId,
        original.fund,
        original.preAuthId,
      );
      if (original.coPayAssessmentId) {
        const [assessment] = await tx
          .select({ id: shaCoPayAssessments.id })
          .from(shaCoPayAssessments)
          .where(
            and(
              eq(shaCoPayAssessments.facilityId, values.facilityId),
              eq(shaCoPayAssessments.id, original.coPayAssessmentId),
              eq(shaCoPayAssessments.patientId, original.patientId),
              eq(shaCoPayAssessments.encounterId, original.encounterId),
              eq(shaCoPayAssessments.invoiceId, original.invoiceId ?? ""),
            ),
          )
          .limit(1);
        if (!assessment) {
          throw new Error("The linked co-pay assessment no longer matches this claim");
        }
      }

      const denialRows = await tx
        .select()
        .from(claimDenials)
        .where(
          and(
            eq(claimDenials.facilityId, values.facilityId),
            eq(claimDenials.claimId, original.id),
          ),
        );
      const denial =
        (values.denialId ? denialRows.find((row) => row.id === values.denialId) : denialRows[0]) ??
        null;
      if (!denial) throw new Error("A denial reason is required before rework");

      const originalLines = await tx
        .select()
        .from(claimLines)
        .where(eq(claimLines.claimId, original.id));
      if (originalLines.length === 0) throw new Error("The original claim has no lines");
      const adjustments = new Map(
        (values.lineAdjustments ?? []).map((adjustment) => [adjustment.claimLineId, adjustment.amount]),
      );
      const adjustedLines = originalLines.map((line) =>
        persistedLineInput(line, adjustments.get(line.id) ?? line.amount),
      );
      const itemRows = await tx
        .select()
        .from(benefitPackageItems)
        .where(
          and(
            eq(benefitPackageItems.facilityId, values.facilityId),
            eq(benefitPackageItems.benefitPackageId, packageRow.id),
          ),
        );
      // Rework re-prices against the current tariff and re-checks coverage and
      // the carried pre-authorisation before creating the new draft.
      const priced = priceShaLines(itemRows, adjustedLines, preauth);
      const billedCents = priced.reduce((sum, line) => sum + line.billedCents, 0);
      const coPayCents = priced.reduce((sum, line) => sum + line.coPayCents, 0);
      const totalCents = billedCents + coPayCents;
      if (totalCents <= 0) throw new Error("A reworked claim total must be greater than zero");

      const facility = await loadFacility(tx, values.facilityId);
      const claimNo = await nextFormattedNumber(tx, facility, "claim");
      const claimId = newId();
      await tx.insert(claims).values({
        id: claimId,
        facilityId: values.facilityId,
        payerId: original.payerId,
        patientId: original.patientId,
        encounterId: original.encounterId,
        invoiceId: original.invoiceId,
        claimNo,
        status: "draft",
        fund: original.fund,
        empanelmentId: original.empanelmentId,
        benefitPackageId: original.benefitPackageId,
        preAuthId: preauth?.id ?? null,
        coPayAssessmentId: original.coPayAssessmentId,
        tariffVersion: empanelment.tariffVersion,
        shaClaimRef: original.shaClaimRef,
        total: fromCents(totalCents),
        billedAmount: fromCents(billedCents),
        patientCoPay: fromCents(coPayCents),
        supersedesClaimId: original.id,
        notes:
          values.note?.trim() ||
          `Rework of ${original.claimNo}: ${denial.reason}${denial.shaDenialCode ? ` (${denial.shaDenialCode})` : ""}`,
        createdBy: userId,
      });
      await tx.insert(claimLines).values(
        priced.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          claimId,
          chargeId: line.chargeId ?? null,
          serviceId: line.serviceId ?? null,
          description: line.description,
          amount: line.amount,
          shaServiceCode: line.shaServiceCode?.trim() || null,
          unitPrice: line.unitPrice ?? line.amount,
          quantity: line.quantity,
          approvedAmount: "0",
          ...lineSnapshot(line),
        })),
      );
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_claim.rework",
        module: "revenue",
        entity: "claims",
        entityId: claimId,
        details: {
          claimNo,
          supersedesClaimId: original.id,
          shaClaimRef: original.shaClaimRef,
          denialReason: denial.reason,
          denialCode: denial.shaDenialCode,
          total: fromCents(totalCents),
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return {
        claimId,
        claimNo,
        shaClaimRef: original.shaClaimRef,
        status: "draft",
        supersedesClaimId: original.id,
        denialReason: denial.reason,
        lineCount: priced.length,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Remittances                                                         */
/* ------------------------------------------------------------------ */

const remittanceAllocationSchema = z.object({
  claimLineId: z.uuid(),
  amount: positiveMoney,
});

export const recordShaRemittanceSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  allocations: z.array(remittanceAllocationSchema).min(1).max(100),
  waiverId: z.uuid().nullable().optional(),
  shaPaymentReportRef: z.string().trim().max(64).nullable().optional(),
  bankReference: z.string().trim().max(64).nullable().optional(),
  paymentDate: isoDate.nullable().optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  receivedAt: z.coerce.date().optional(),
});

export interface ShaRemittanceResult {
  remittanceIds: string[];
  remittanceNos: string[];
  claimId: string;
  claimNo: string;
  amount: string;
  paidAmount: string;
  outstanding: string;
  status: string;
  journalEntryNo: string | null;
  waiverId: string | null;
}

export async function recordShaRemittance(
  input: z.input<typeof recordShaRemittanceSchema>,
  options: CommandOptions = {},
): Promise<ShaRemittanceResult> {
  const values = recordShaRemittanceSchema.parse(input);
  const userId = actorId(values);
  const amountCents = values.allocations.reduce((sum, line) => sum + toCents(line.amount), 0);
  if (amountCents <= 0) throw new Error("A remittance must be greater than zero");
  const amount = fromCents(amountCents);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordShaRemittance",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      if (claim.status !== "accepted" && claim.status !== "paid") {
        throw new Error("Record a remittance only against an approved or paid SHA claim");
      }
      if (toCents(claim.approvedAmount) <= 0) {
        throw new Error("Adjudicate the claim before recording a remittance");
      }
      assertDifferentActor(userId, claim.createdBy, "The claim preparer cannot record a remittance");
      assertDifferentActor(userId, claim.submittedBy, "The claim submitter cannot record a remittance");
      assertDifferentActor(userId, claim.approvedBy, "The claim approver cannot record a remittance");

      const validLines = await tx
        .select({ id: claimLines.id })
        .from(claimLines)
        .where(eq(claimLines.claimId, claim.id));
      const validIds = new Set(validLines.map((line) => line.id));
      for (const allocation of values.allocations) {
        if (!validIds.has(allocation.claimLineId)) {
          throw new Error("A remittance allocation belongs to a different claim");
        }
      }

      const outstandingCents = Math.max(
        0,
        toCents(claim.approvedAmount) - toCents(claim.paidAmount),
      );
      const excessCents = Math.max(0, amountCents - outstandingCents);
      let waiverId: string | null = null;
      if (excessCents > 0) {
        if (!values.waiverId) {
          await auditExcessRemittanceRefusal(options.database ?? db, values, userId, claim, {
            amount: fromCents(amountCents),
            outstanding: fromCents(outstandingCents),
            excess: fromCents(excessCents),
            reason: "approved_waiver_required",
          });
          throw new Error(
            `The remittance exceeds the approved balance by ${fromCents(excessCents)}; an approved waiver is required`,
          );
        }
        const [waiver] = await tx
          .select()
          .from(shaWaivers)
          .where(
            and(
              eq(shaWaivers.facilityId, values.facilityId),
              eq(shaWaivers.id, values.waiverId),
              eq(shaWaivers.status, "approved"),
            ),
          )
          .limit(1);
        if (!waiver || toCents(waiver.amount) < excessCents) {
          await auditExcessRemittanceRefusal(options.database ?? db, values, userId, claim, {
            amount: fromCents(amountCents),
            excess: fromCents(excessCents),
            waiverId: values.waiverId,
            reason: "waiver_missing_or_insufficient",
          });
          throw new Error("The approved waiver does not cover the excess remittance");
        }
        if (waiver.requestedBy === userId) {
          await auditExcessRemittanceRefusal(options.database ?? db, values, userId, claim, {
            amount: fromCents(amountCents),
            excess: fromCents(excessCents),
            waiverId: values.waiverId,
            reason: "requester_cannot_use_own_waiver",
          });
          throw new ForbiddenError("The requester cannot use their own waiver to cover an excess");
        }
        waiverId = waiver.id;
      }

      const facility = await loadFacility(tx, values.facilityId);
      const remittanceIds: string[] = [];
      const remittanceNos: string[] = [];
      const receivedAt = values.receivedAt ?? new Date();
      for (const allocation of values.allocations) {
        const remittanceId = newId();
        const remittanceNo = await nextFormattedNumber(tx, facility, "remittance");
        await tx.insert(remittances).values({
          id: remittanceId,
          facilityId: values.facilityId,
          claimId: claim.id,
          claimLineId: allocation.claimLineId,
          remittanceNo,
          amount: allocation.amount,
          receivedAt,
          shaPaymentReportRef: values.shaPaymentReportRef?.trim() || null,
          bankReference: values.bankReference?.trim() || null,
          paymentDate: values.paymentDate ?? null,
          reference: values.reference?.trim() || null,
          createdBy: userId,
        });
        remittanceIds.push(remittanceId);
        remittanceNos.push(remittanceNo);
      }

      const paidAmount = fromCents(toCents(claim.paidAmount) + amountCents);
      const settled = toCents(paidAmount) >= toCents(claim.approvedAmount);
      const status: ClaimStatus = settled ? "paid" : "accepted";
      await tx
        .update(claims)
        .set({
          paidAmount,
          status,
          waiverId: waiverId ?? claim.waiverId,
          resolvedAt: settled ? receivedAt : claim.resolvedAt,
          updatedAt: new Date(),
          version: sql`${claims.version} + 1`,
        })
        .where(eq(claims.id, claim.id));

      const journal = await tryPostJournal(tx, {
        facilityId: values.facilityId,
        entryDate: (values.paymentDate ?? receivedAt.toISOString().slice(0, 10)),
        description: `SHA remittance for claim ${claim.claimNo}`,
        sourceType: "sha_remittance",
        sourceId: claim.id,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        lines: [
          { systemRole: "bank", debit: amount, description: `SHA payment ${remittanceNos.join(", ")}` },
          {
            systemRole: "insurance_receivable",
            credit: amount,
            description: `Claim ${claim.claimNo}`,
          },
        ],
      });
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_remittance.record",
        module: "revenue",
        entity: "remittances",
        entityId: remittanceIds[0],
        details: {
          remittanceNos,
          claimNo: claim.claimNo,
          amount,
          paidAmount,
          status,
          waiverId,
          journalEntryNo: journal?.entryNo ?? null,
          allocations: values.allocations,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "sha.remittance.recorded",
        facilityId: values.facilityId,
        claimId: claim.id,
        amount,
      });
      return {
        remittanceIds,
        remittanceNos,
        claimId: claim.id,
        claimNo: claim.claimNo,
        amount,
        paidAmount,
        outstanding: claimOutstanding(claim.approvedAmount, paidAmount),
        status,
        journalEntryNo: journal?.entryNo ?? null,
        waiverId,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Payment-report reconciliation                                       */
/* ------------------------------------------------------------------ */

const reconciliationLineSchema = z.object({
  claimRef: z.string().trim().min(1).max(64),
  shaAmount: positiveMoney,
  reason: z.string().trim().max(500).nullable().optional(),
});

export const reconcileShaPaymentReportSchema = z.object({
  ...baseSchema,
  kmpdcNumber: z.string().trim().min(1).max(64),
  reportPeriod: isoMonth,
  reportRef: z.string().trim().max(64).nullable().optional(),
  shaReportedAmount: money,
  lines: z.array(reconciliationLineSchema).min(1).max(500),
  paymentDate: isoDate.nullable().optional(),
});

export interface ShaReconciliationResult {
  reconciliationId: string;
  kmpdcNumber: string;
  reportPeriod: string;
  shaReportedAmount: string;
  facilityInvoicedAmount: string;
  matchedAmount: string;
  unmatchedAmount: string;
  variance: string;
  status: string;
  journalEntryNo: string | null;
  lines: Array<{
    claimRef: string;
    claimId: string | null;
    shaAmount: string;
    facilityAmount: string;
    variance: string;
    status: string;
  }>;
}

export async function reconcileShaPaymentReport(
  input: z.input<typeof reconcileShaPaymentReportSchema>,
  options: CommandOptions = {},
): Promise<ShaReconciliationResult> {
  const values = reconcileShaPaymentReportSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "reconcileShaPaymentReport",
    async (tx) => {
      const duplicate = await tx
        .select({ id: shaPaymentReconciliation.id })
        .from(shaPaymentReconciliation)
        .where(
          and(
            eq(shaPaymentReconciliation.facilityId, values.facilityId),
            eq(shaPaymentReconciliation.kmpdcNumber, values.kmpdcNumber),
            eq(shaPaymentReconciliation.reportPeriod, values.reportPeriod),
          ),
        )
        .limit(1);
      if (duplicate[0]) {
        throw new Error(
          `Payment report for ${values.kmpdcNumber} / ${values.reportPeriod} is already reconciled`,
        );
      }

      const allClaims = await tx
        .select({
          id: claims.id,
          claimNo: claims.claimNo,
          shaClaimRef: claims.shaClaimRef,
          billedAmount: claims.billedAmount,
          approvedAmount: claims.approvedAmount,
          paidAmount: claims.paidAmount,
          submittedAt: claims.submittedAt,
          empanelmentId: claims.empanelmentId,
        })
        .from(claims)
        .where(eq(claims.facilityId, values.facilityId));
      const empanelmentIds = new Set(
        allClaims.map((claim) => claim.empanelmentId).filter((id): id is string => Boolean(id)),
      );
      const empanelments = empanelmentIds.size
        ? await tx
            .select({ id: shaEmpanelments.id, kmpdcNumber: shaEmpanelments.kmpdcNumber })
            .from(shaEmpanelments)
            .where(eq(shaEmpanelments.facilityId, values.facilityId))
        : [];
      const kmpdcById = new Map(empanelments.map((row) => [row.id, row.kmpdcNumber]));

      const preparedLines: Array<{
        claimRef: string;
        claimId: string | null;
        shaAmount: string;
        facilityAmount: string;
        variance: string;
        status: "matched" | "unmatched" | "variance";
        reason: string | null;
      }> = values.lines.map((line) => {
        const claim =
          allClaims.find((candidate) => candidate.shaClaimRef === line.claimRef) ??
          allClaims.find((candidate) => candidate.claimNo === line.claimRef) ??
          null;
        const matchesKmpdc =
          claim?.empanelmentId != null && kmpdcById.get(claim.empanelmentId) === values.kmpdcNumber;
        const matchesPeriod =
          claim?.submittedAt != null &&
          claim.submittedAt.toISOString().slice(0, 7) === values.reportPeriod;
        const matched = Boolean(claim && matchesKmpdc && matchesPeriod);
        const facilityAmount = matched
          ? toCents(claim!.approvedAmount) > 0
            ? claim!.approvedAmount
            : claim!.billedAmount
          : "0";
        const variance = fromCents(toCents(line.shaAmount) - toCents(facilityAmount));
        return {
          claimRef: line.claimRef,
          claimId: matched ? claim!.id : null,
          shaAmount: line.shaAmount,
          facilityAmount,
          variance,
          status: matched ? (toCents(variance) === 0 ? "matched" : "variance") : "unmatched",
          reason:
            line.reason ??
            (matched ? null : "SHA payment could not be matched to a claim for this KMPDC/period"),
        };
      });

      const matchedCents = preparedLines
        .filter((line) => line.status === "matched")
        .reduce((sum, line) => sum + toCents(line.shaAmount), 0);
      const shaCents = toCents(values.shaReportedAmount);
      const invoicedCents = preparedLines.reduce(
        (sum, line) => sum + toCents(line.facilityAmount),
        0,
      );
      const unmatchedCents = Math.max(0, shaCents - matchedCents);
      const varianceCents = shaCents - invoicedCents;
      const hasVariance = preparedLines.some((line) => line.status !== "matched") || varianceCents !== 0;

      const reconciliationId = newId();
      await tx.insert(shaPaymentReconciliation).values({
        id: reconciliationId,
        facilityId: values.facilityId,
        kmpdcNumber: values.kmpdcNumber,
        reportPeriod: values.reportPeriod,
        reportRef: values.reportRef?.trim() || null,
        shaReportedAmount: values.shaReportedAmount,
        facilityInvoicedAmount: fromCents(invoicedCents),
        matchedAmount: fromCents(matchedCents),
        unmatchedAmount: fromCents(unmatchedCents),
        variance: fromCents(varianceCents),
        status: hasVariance ? "variance" : "posted",
        generatedBy: userId,
        createdBy: userId,
      });
      await tx.insert(shaReconciliationLines).values(
        preparedLines.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          reconciliationId,
          claimId: line.claimId,
          claimNo: line.claimRef,
          shaAmount: line.shaAmount,
          facilityAmount: line.facilityAmount,
          variance: line.variance,
          status: line.status,
          reason: line.reason,
          createdBy: userId,
        })),
      );

      // Only post cash that has not already been posted by a SHA remittance.
      const matchedIds = preparedLines
        .map((line) => line.claimId)
        .filter((id): id is string => Boolean(id));
      const postedCents = matchedIds.length
        ? (
            await tx
              .select({ total: sql<string>`coalesce(sum(${remittances.amount}), 0)` })
              .from(remittances)
              .where(
                and(
                  eq(remittances.facilityId, values.facilityId),
                  inArray(remittances.claimId, matchedIds),
                  values.reportRef
                    ? eq(remittances.shaPaymentReportRef, values.reportRef)
                    : isNull(remittances.shaPaymentReportRef),
                ),
              )
          )[0]?.total ?? "0"
        : "0";
      const cashToPostCents = Math.max(0, shaCents - toCents(postedCents));
      let journal = null;
      if (cashToPostCents > 0) {
        journal = await tryPostJournal(tx, {
          facilityId: values.facilityId,
          entryDate: values.paymentDate ?? `${values.reportPeriod}-28`,
          description: `SHA payment report ${values.reportRef ?? values.reportPeriod}`,
          sourceType: "sha_reconciliation",
          sourceId: reconciliationId,
          userId,
          ip: values.actor.ip,
          deviceId: values.actor.deviceId,
          lines: [
            {
              systemRole: "bank",
              debit: fromCents(cashToPostCents),
              description: `SHA payment ${values.reportRef ?? values.reportPeriod}`,
            },
            {
              systemRole: "insurance_receivable",
              credit: fromCents(cashToPostCents),
              description: `SHA payment report ${values.reportPeriod}`,
            },
          ],
        });
        await tx
          .update(shaPaymentReconciliation)
          .set({ journalEntryId: journal?.entryId ?? null })
          .where(eq(shaPaymentReconciliation.id, reconciliationId));
      }

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "sha_reconciliation.import",
        module: "revenue",
        entity: "sha_payment_reconciliation",
        entityId: reconciliationId,
        details: {
          kmpdcNumber: values.kmpdcNumber,
          reportPeriod: values.reportPeriod,
          reportRef: values.reportRef ?? null,
          shaReportedAmount: values.shaReportedAmount,
          facilityInvoicedAmount: fromCents(invoicedCents),
          matchedAmount: fromCents(matchedCents),
          unmatchedAmount: fromCents(unmatchedCents),
          variance: fromCents(varianceCents),
          journalEntryNo: journal?.entryNo ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "sha.reconciliation.imported",
        facilityId: values.facilityId,
        reconciliationId,
        variance: fromCents(varianceCents),
      });
      return {
        reconciliationId,
        kmpdcNumber: values.kmpdcNumber,
        reportPeriod: values.reportPeriod,
        shaReportedAmount: values.shaReportedAmount,
        facilityInvoicedAmount: fromCents(invoicedCents),
        matchedAmount: fromCents(matchedCents),
        unmatchedAmount: fromCents(unmatchedCents),
        variance: fromCents(varianceCents),
        status: hasVariance ? "variance" : "posted",
        journalEntryNo: journal?.entryNo ?? null,
        lines: preparedLines.map(({
          claimRef,
          claimId,
          shaAmount,
          facilityAmount,
          variance,
          status,
        }) => ({ claimRef, claimId, shaAmount, facilityAmount, variance, status })),
      };
    },
    options,
  );
}
