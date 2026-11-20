import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import {
  CLAIM_STATUSES,
  PAYER_KINDS,
  PAYER_CONTRACT_STATUSES,
  assertClaimTransition,
  claimOutstanding,
  type ClaimStatus,
} from "@/lib/finance";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import {
  charges,
  claimDenials,
  claimLines,
  claims,
  encounters,
  facilities,
  invoices,
  payerBenefits,
  payerContracts,
  payers,
  preAuthorizations,
  remittances,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { tryPostJournal } from "@/server/ledger";
import { nextFormattedNumber } from "@/server/numbering";

import { assertValidPayerSharingConsent } from "./privacy";
import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";
import { assertFacilityReady } from "./regulatory";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)");
const money = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)));

async function loadPayer(tx: CommandTransaction, facilityId: string, payerId: string) {
  const rows = await tx
    .select()
    .from(payers)
    .where(and(eq(payers.id, payerId), eq(payers.facilityId, facilityId)))
    .limit(1);
  const payer = rows[0];
  if (!payer) throw new Error("Payer not found in this facility");
  return payer;
}

async function loadClaim(tx: CommandTransaction, facilityId: string, claimId: string) {
  const rows = await tx
    .select()
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.facilityId, facilityId)))
    .limit(1)
    .for("update");
  const claim = rows[0];
  if (!claim) throw new Error("Claim not found in this facility");
  return claim;
}

async function loadFacilityForNumbering(tx: CommandTransaction, facilityId: string) {
  const rows = await tx
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const facility = rows[0];
  if (!facility) throw new Error("Facility not found");
  return facility;
}

/* ------------------------------------------------------------------ */
/* Payers and contracts                                                */
/* ------------------------------------------------------------------ */

export const createPayerSchema = z.object({
  ...baseSchema,
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9.-]+$/, "Use letters, numbers, dots or dashes"),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(PAYER_KINDS).default("insurer"),
  contactName: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.email().max(255).nullable().optional(),
});

export type CreatePayerInput = z.input<typeof createPayerSchema>;
export interface PayerResult {
  payerId: string;
  code: string;
  name: string;
  kind: string;
}

export async function createPayer(
  input: CreatePayerInput,
  options: CommandOptions = {},
): Promise<PayerResult> {
  const values = createPayerSchema.parse(input);
  const userId = actorId(values);
  const code = values.code.toUpperCase();

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPayer",
    async (tx) => {
      const duplicate = await tx
        .select({ id: payers.id })
        .from(payers)
        .where(and(eq(payers.facilityId, values.facilityId), eq(payers.code, code)))
        .limit(1);
      if (duplicate[0]) throw new Error(`Payer code ${code} already exists`);

      const payerId = newId();
      await tx.insert(payers).values({
        id: payerId,
        facilityId: values.facilityId,
        code,
        name: values.name,
        kind: values.kind,
        contactName: values.contactName?.trim() || null,
        phone: values.phone?.trim() || null,
        email: values.email?.trim() || null,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payer.create",
        module: "revenue",
        entity: "payers",
        entityId: payerId,
        details: { code, name: values.name, kind: values.kind },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { payerId, code, name: values.name, kind: values.kind };
    },
    options,
  );
}

export const updatePayerSchema = z.object({
  ...baseSchema,
  payerId: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.email().max(255).nullable().optional(),
  active: z.boolean().optional(),
});

export type UpdatePayerInput = z.input<typeof updatePayerSchema>;
export interface UpdatePayerResult {
  payerId: string;
  name: string;
  active: boolean;
}

export async function updatePayer(
  input: UpdatePayerInput,
  options: CommandOptions = {},
): Promise<UpdatePayerResult> {
  const values = updatePayerSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updatePayer",
    async (tx) => {
      const payer = await loadPayer(tx, values.facilityId, values.payerId);
      const now = new Date();
      const name = values.name ?? payer.name;
      const active = values.active ?? payer.active;
      await tx
        .update(payers)
        .set({
          name,
          contactName:
            values.contactName === undefined ? payer.contactName : values.contactName || null,
          phone: values.phone === undefined ? payer.phone : values.phone || null,
          email: values.email === undefined ? payer.email : values.email || null,
          active,
          updatedAt: now,
          version: sql`${payers.version} + 1`,
        })
        .where(and(eq(payers.id, payer.id), eq(payers.facilityId, values.facilityId)));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payer.update",
        module: "revenue",
        entity: "payers",
        entityId: payer.id,
        details: { name, active },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { payerId: payer.id, name, active };
    },
    options,
  );
}

export const createPayerContractSchema = z.object({
  ...baseSchema,
  payerId: z.uuid(),
  contractNo: z.string().trim().min(1).max(64),
  startDate: isoDate,
  endDate: isoDate,
  notes: z.string().trim().max(1_000).nullable().optional(),
});

export type CreatePayerContractInput = z.input<typeof createPayerContractSchema>;
export interface PayerContractResult {
  contractId: string;
  payerId: string;
  contractNo: string;
  startDate: string;
  endDate: string;
  status: string;
}

export async function createPayerContract(
  input: CreatePayerContractInput,
  options: CommandOptions = {},
): Promise<PayerContractResult> {
  const values = createPayerContractSchema.parse(input);
  const userId = actorId(values);
  if (values.endDate < values.startDate) {
    throw new Error("The contract end date must be on or after the start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPayerContract",
    async (tx) => {
      const payer = await loadPayer(tx, values.facilityId, values.payerId);
      const duplicate = await tx
        .select({ id: payerContracts.id })
        .from(payerContracts)
        .where(
          and(
            eq(payerContracts.facilityId, values.facilityId),
            eq(payerContracts.contractNo, values.contractNo),
          ),
        )
        .limit(1);
      if (duplicate[0]) throw new Error(`Contract ${values.contractNo} already exists`);

      const contractId = newId();
      await tx.insert(payerContracts).values({
        id: contractId,
        facilityId: values.facilityId,
        payerId: payer.id,
        contractNo: values.contractNo,
        startDate: values.startDate,
        endDate: values.endDate,
        status: "active",
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payer_contract.create",
        module: "revenue",
        entity: "payer_contracts",
        entityId: contractId,
        details: {
          payerId: payer.id,
          contractNo: values.contractNo,
          startDate: values.startDate,
          endDate: values.endDate,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        contractId,
        payerId: payer.id,
        contractNo: values.contractNo,
        startDate: values.startDate,
        endDate: values.endDate,
        status: "active",
      };
    },
    options,
  );
}

export const setPayerContractStatusSchema = z.object({
  ...baseSchema,
  contractId: z.uuid(),
  status: z.enum(PAYER_CONTRACT_STATUSES),
});

export type SetPayerContractStatusInput = z.input<typeof setPayerContractStatusSchema>;
export interface SetPayerContractStatusResult {
  contractId: string;
  status: string;
}

export async function setPayerContractStatus(
  input: SetPayerContractStatusInput,
  options: CommandOptions = {},
): Promise<SetPayerContractStatusResult> {
  const values = setPayerContractStatusSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setPayerContractStatus",
    async (tx) => {
      const rows = await tx
        .select()
        .from(payerContracts)
        .where(
          and(
            eq(payerContracts.id, values.contractId),
            eq(payerContracts.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const contract = rows[0];
      if (!contract) throw new Error("Contract not found in this facility");

      await tx
        .update(payerContracts)
        .set({
          status: values.status,
          updatedAt: new Date(),
          version: sql`${payerContracts.version} + 1`,
        })
        .where(
          and(
            eq(payerContracts.id, contract.id),
            eq(payerContracts.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payer_contract.status",
        module: "revenue",
        entity: "payer_contracts",
        entityId: contract.id,
        details: { before: contract.status, after: values.status },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { contractId: contract.id, status: values.status };
    },
    options,
  );
}

export const createPayerBenefitSchema = z.object({
  ...baseSchema,
  contractId: z.uuid(),
  serviceId: z.uuid().nullable().optional(),
  category: z.string().trim().min(1).max(64),
  annualLimit: money.nullable().optional(),
  perVisitLimit: money.nullable().optional(),
  copayPercent: z
    .union([z.string(), z.number()])
    .transform((value) => fromCents(toCents(value)))
    .default("0"),
});

export type CreatePayerBenefitInput = z.input<typeof createPayerBenefitSchema>;
export interface PayerBenefitResult {
  benefitId: string;
  contractId: string;
  category: string;
  copayPercent: string;
}

export async function createPayerBenefit(
  input: CreatePayerBenefitInput,
  options: CommandOptions = {},
): Promise<PayerBenefitResult> {
  const values = createPayerBenefitSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPayerBenefit",
    async (tx) => {
      const rows = await tx
        .select({ id: payerContracts.id })
        .from(payerContracts)
        .where(
          and(
            eq(payerContracts.id, values.contractId),
            eq(payerContracts.facilityId, values.facilityId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw new Error("Contract not found in this facility");

      const benefitId = newId();
      await tx.insert(payerBenefits).values({
        id: benefitId,
        facilityId: values.facilityId,
        contractId: values.contractId,
        serviceId: values.serviceId ?? null,
        category: values.category,
        annualLimit: values.annualLimit ?? null,
        perVisitLimit: values.perVisitLimit ?? null,
        copayPercent: values.copayPercent,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "payer_benefit.create",
        module: "revenue",
        entity: "payer_benefits",
        entityId: benefitId,
        details: { contractId: values.contractId, category: values.category },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        benefitId,
        contractId: values.contractId,
        category: values.category,
        copayPercent: values.copayPercent,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Pre-authorisation                                                   */
/* ------------------------------------------------------------------ */

export const requestPreAuthorizationSchema = z.object({
  ...baseSchema,
  payerId: z.uuid(),
  contractId: z.uuid().nullable().optional(),
  sharingAgreementId: z.uuid().nullable().optional(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable().optional(),
  requestedAmount: money,
  reference: z.string().trim().max(200).nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  notes: z.string().trim().max(1_000).nullable().optional(),
});

export type RequestPreAuthorizationInput = z.input<typeof requestPreAuthorizationSchema>;
export interface PreAuthorizationResult {
  preAuthId: string;
  authNo: string;
  payerId: string;
  patientId: string;
  requestedAmount: string;
  status: string;
}

export async function requestPreAuthorization(
  input: RequestPreAuthorizationInput,
  options: CommandOptions = {},
): Promise<PreAuthorizationResult> {
  const values = requestPreAuthorizationSchema.parse(input);
  const userId = actorId(values);
  if (toCents(values.requestedAmount) <= 0) {
    throw new Error("A pre-authorisation must request more than zero");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "requestPreAuthorization",
    async (tx) => {
      const payer = await loadPayer(tx, values.facilityId, values.payerId);
      await assertValidPayerSharingConsent(tx, {
        facilityId: values.facilityId,
        patientId: values.patientId,
        actor: values.actor,
        action: "revenue.preauth.share_refused",
        entity: "pre_authorizations",
        entityId: null,
        details: { payerId: payer.id, encounterId: values.encounterId ?? null },
        sharingAgreementId: values.sharingAgreementId ?? null,
      });
      const facility = await loadFacilityForNumbering(tx, values.facilityId);
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
        requestedAmount: values.requestedAmount,
        status: "requested",
        reference: values.reference?.trim() || null,
        expiresAt: values.expiresAt ?? null,
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "preauth.request",
        module: "revenue",
        entity: "pre_authorizations",
        entityId: preAuthId,
        details: {
          authNo,
          payerId: payer.id,
          patientId: values.patientId,
          requestedAmount: values.requestedAmount,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        preAuthId,
        authNo,
        payerId: payer.id,
        patientId: values.patientId,
        requestedAmount: values.requestedAmount,
        status: "requested",
      };
    },
    options,
  );
}

export const decidePreAuthorizationSchema = z.object({
  ...baseSchema,
  preAuthId: z.uuid(),
  decision: z.enum(["approved", "declined", "expired"]),
  approvedAmount: money.nullable().optional(),
  notes: z.string().trim().max(1_000).nullable().optional(),
});

export type DecidePreAuthorizationInput = z.input<typeof decidePreAuthorizationSchema>;
export interface DecidePreAuthorizationResult {
  preAuthId: string;
  authNo: string;
  status: string;
  approvedAmount: string | null;
}

export async function decidePreAuthorization(
  input: DecidePreAuthorizationInput,
  options: CommandOptions = {},
): Promise<DecidePreAuthorizationResult> {
  const values = decidePreAuthorizationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "decidePreAuthorization",
    async (tx) => {
      const rows = await tx
        .select()
        .from(preAuthorizations)
        .where(
          and(
            eq(preAuthorizations.id, values.preAuthId),
            eq(preAuthorizations.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const auth = rows[0];
      if (!auth) throw new Error("Pre-authorisation not found in this facility");
      if (auth.status !== "requested") {
        throw new Error(`This pre-authorisation is already ${auth.status}`);
      }
      if (
        values.decision === "approved" &&
        toCents(values.approvedAmount ?? "0") <= 0
      ) {
        throw new Error("An approved pre-authorisation needs an approved amount");
      }

      const now = new Date();
      const approvedAmount =
        values.decision === "approved" ? (values.approvedAmount ?? null) : null;
      await tx
        .update(preAuthorizations)
        .set({
          status: values.decision,
          approvedAmount,
          notes: values.notes?.trim() || auth.notes,
          decidedAt: now,
          decidedBy: userId,
          updatedAt: now,
          version: sql`${preAuthorizations.version} + 1`,
        })
        .where(
          and(
            eq(preAuthorizations.id, auth.id),
            eq(preAuthorizations.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "preauth.decide",
        module: "revenue",
        entity: "pre_authorizations",
        entityId: auth.id,
        details: {
          authNo: auth.authNo,
          decision: values.decision,
          approvedAmount,
          notes: values.notes ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "preauth.decided",
        facilityId: values.facilityId,
        preAuthId: auth.id,
        authNo: auth.authNo,
        status: values.decision,
        approvedAmount,
      });

      return {
        preAuthId: auth.id,
        authNo: auth.authNo,
        status: values.decision,
        approvedAmount,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export const claimLineInputSchema = z.object({
  chargeId: z.uuid().nullable().optional(),
  serviceId: z.uuid().nullable().optional(),
  description: z.string().trim().min(1).max(500),
  amount: money,
  approvedAmount: money.optional(),
});

export const createClaimSchema = z.object({
  ...baseSchema,
  payerId: z.uuid(),
  contractId: z.uuid().nullable().optional(),
  sharingAgreementId: z.uuid().nullable().optional(),
  patientId: z.uuid(),
  encounterId: z.uuid(),
  invoiceId: z.uuid().nullable().optional(),
  preAuthId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1_000).nullable().optional(),
  lines: z.array(claimLineInputSchema).max(100).optional(),
});

export type CreateClaimInput = z.input<typeof createClaimSchema>;
export interface ClaimResult {
  claimId: string;
  claimNo: string;
  status: string;
  total: string;
  lineCount: number;
}

export async function createClaim(
  input: CreateClaimInput,
  options: CommandOptions = {},
): Promise<ClaimResult> {
  const values = createClaimSchema.parse(input);
  const userId = actorId(values);

  await assertFacilityReady(
    { facilityId: values.facilityId, action: "claiming", actor: values.actor },
    options,
  );

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createClaim",
    async (tx) => {
      const payer = await loadPayer(tx, values.facilityId, values.payerId);

      const encounterRows = await tx
        .select({ id: encounters.id, patientId: encounters.patientId })
        .from(encounters)
        .where(
          and(
            eq(encounters.id, values.encounterId),
            eq(encounters.facilityId, values.facilityId),
          ),
        )
        .limit(1);
      const encounter = encounterRows[0];
      if (!encounter) throw new Error("Encounter not found in this facility");
      if (encounter.patientId !== values.patientId) {
        throw new Error("The encounter belongs to a different patient");
      }

      await assertValidPayerSharingConsent(tx, {
        facilityId: values.facilityId,
        patientId: values.patientId,
        actor: values.actor,
        action: "revenue.claim.create_refused",
        entity: "claims",
        entityId: null,
        details: {
          payerId: payer.id,
          encounterId: encounter.id,
          invoiceId: values.invoiceId ?? null,
        },
        sharingAgreementId: values.sharingAgreementId ?? null,
      });

      let invoiceId: string | null = null;
      let derivedLines = values.lines;
      if (values.invoiceId) {
        const invoiceRows = await tx
          .select({ id: invoices.id, encounterId: invoices.encounterId, status: invoices.status })
          .from(invoices)
          .where(
            and(eq(invoices.id, values.invoiceId), eq(invoices.facilityId, values.facilityId)),
          )
          .limit(1);
        const invoice = invoiceRows[0];
        if (!invoice) throw new Error("Invoice not found in this facility");
        if (invoice.encounterId !== encounter.id) {
          throw new Error("The invoice belongs to a different encounter");
        }
        if (invoice.status === "void") throw new Error("A void invoice cannot be claimed");
        invoiceId = invoice.id;

        if (!derivedLines) {
          const chargeRows = await tx
            .select({
              id: charges.id,
              serviceId: charges.serviceId,
              description: charges.description,
              amount: charges.amount,
            })
            .from(charges)
            .where(
              and(
                eq(charges.facilityId, values.facilityId),
                eq(charges.invoiceId, invoice.id),
                isNull(charges.voidedAt),
              ),
            )
            .orderBy(asc(charges.createdAt));
          derivedLines = chargeRows.map((charge) => ({
            chargeId: charge.id,
            serviceId: charge.serviceId,
            description: charge.description,
            amount: fromCents(toCents(charge.amount)),
          }));
        }
      }

      if (!derivedLines || derivedLines.length === 0) {
        throw new Error("A claim needs at least one line, or an invoice with charges");
      }

      const totalCents = derivedLines.reduce((sum, line) => sum + toCents(line.amount), 0);
      if (totalCents <= 0) throw new Error("A claim total must be greater than zero");

      const facility = await loadFacilityForNumbering(tx, values.facilityId);
      const claimNo = await nextFormattedNumber(tx, facility, "claim");
      const claimId = newId();
      const total = fromCents(totalCents);

      await tx.insert(claims).values({
        id: claimId,
        facilityId: values.facilityId,
        payerId: payer.id,
        contractId: values.contractId ?? null,
        patientId: values.patientId,
        encounterId: encounter.id,
        invoiceId,
        claimNo,
        status: "draft",
        total,
        notes: values.notes?.trim() || null,
        createdBy: userId,
      });

      await tx.insert(claimLines).values(
        derivedLines.map((line) => ({
          id: newId(),
          facilityId: values.facilityId,
          claimId,
          chargeId: line.chargeId ?? null,
          serviceId: line.serviceId ?? null,
          description: line.description,
          amount: line.amount,
          approvedAmount: line.approvedAmount ?? "0.00",
        })),
      );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "claim.create",
        module: "revenue",
        entity: "claims",
        entityId: claimId,
        details: {
          claimNo,
          payerId: payer.id,
          patientId: values.patientId,
          encounterId: encounter.id,
          invoiceId,
          total,
          lineCount: derivedLines.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "claim.created",
        facilityId: values.facilityId,
        claimId,
        claimNo,
        total,
      });

      return { claimId, claimNo, status: "draft", total, lineCount: derivedLines.length };
    },
    options,
  );
}

export const transitionClaimSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  to: z.enum(CLAIM_STATUSES),
  approvedAmount: money.nullable().optional(),
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type TransitionClaimInput = z.input<typeof transitionClaimSchema>;
export interface TransitionClaimResult {
  claimId: string;
  claimNo: string;
  from: ClaimStatus;
  status: ClaimStatus;
  total: string;
  approvedAmount: string;
  paidAmount: string;
  outstanding: string;
}

export async function transitionClaim(
  input: TransitionClaimInput,
  options: CommandOptions = {},
): Promise<TransitionClaimResult> {
  const values = transitionClaimSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "transitionClaim",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      assertClaimTransition(claim.status, values.to);

      if (values.to === "submitted" || values.to === "resubmitted") {
        await assertValidPayerSharingConsent(tx, {
          facilityId: values.facilityId,
          patientId: claim.patientId,
          actor: values.actor,
          action: "revenue.claim.submit_refused",
          entity: "claims",
          entityId: claim.id,
          details: {
            claimNo: claim.claimNo,
            payerId: claim.payerId,
            to: values.to,
          },
          sharingAgreementId: null,
        });
      }

      if (values.to === "paid" && toCents(claim.paidAmount) <= 0) {
        throw new Error("Record a remittance before marking a claim paid");
      }

      const now = new Date();
      const approvedAmount =
        values.to === "accepted"
          ? (values.approvedAmount ?? claim.total)
          : claim.approvedAmount;
      if (values.to === "accepted" && toCents(approvedAmount) <= 0) {
        throw new Error("An accepted claim needs an approved amount");
      }

      await tx
        .update(claims)
        .set({
          status: values.to,
          approvedAmount,
          submittedAt:
            values.to === "submitted" || values.to === "resubmitted"
              ? now
              : claim.submittedAt,
          resolvedAt: values.to === "paid" || values.to === "closed" ? now : claim.resolvedAt,
          notes: values.note?.trim() || claim.notes,
          updatedAt: now,
          version: sql`${claims.version} + 1`,
        })
        .where(and(eq(claims.id, claim.id), eq(claims.facilityId, values.facilityId)));

      if (values.to === "submitted" && claim.invoiceId) {
        // The invoice first booked a patient receivable. Submitting a claim to
        // the payer moves that same debt into the insurance receivable.
        await tryPostJournal(tx, {
          facilityId: values.facilityId,
          entryDate: now.toISOString().slice(0, 10),
          description: `Claim ${claim.claimNo} submitted to payer`,
          sourceType: "claim_submission",
          sourceId: claim.id,
          userId,
          ip: values.actor.ip,
          deviceId: values.actor.deviceId,
          lines: [
            {
              systemRole: "insurance_receivable",
              debit: claim.total,
              description: `Claim ${claim.claimNo}`,
            },
            {
              systemRole: "patient_receivable",
              credit: claim.total,
              description: `Reclassify invoice ${claim.invoiceId}`,
            },
          ],
        });
      }

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "claim.transition",
        module: "revenue",
        entity: "claims",
        entityId: claim.id,
        details: {
          claimNo: claim.claimNo,
          from: claim.status,
          to: values.to,
          approvedAmount,
          note: values.note ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "claim.transitioned",
        facilityId: values.facilityId,
        claimId: claim.id,
        claimNo: claim.claimNo,
        from: claim.status,
        to: values.to,
      });

      return {
        claimId: claim.id,
        claimNo: claim.claimNo,
        from: claim.status,
        status: values.to,
        total: claim.total,
        approvedAmount,
        paidAmount: claim.paidAmount,
        outstanding: claimOutstanding(approvedAmount, claim.paidAmount),
      };
    },
    options,
  );
}

export const recordRemittanceSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  claimLineId: z.uuid().nullable().optional(),
  amount: z
    .union([z.string(), z.number()])
    .refine((value) => toCents(value) > 0, { message: "A remittance must be greater than zero" }),
  reference: z.string().trim().max(200).nullable().optional(),
  receivedAt: z.coerce.date().optional(),
});

export type RecordRemittanceInput = z.input<typeof recordRemittanceSchema>;
export interface RecordRemittanceResult {
  remittanceId: string;
  remittanceNo: string;
  claimId: string;
  claimNo: string;
  amount: string;
  paidAmount: string;
  outstanding: string;
  status: ClaimStatus;
  journalEntryNo: string | null;
}

export async function recordRemittance(
  input: RecordRemittanceInput,
  options: CommandOptions = {},
): Promise<RecordRemittanceResult> {
  const values = recordRemittanceSchema.parse(input);
  const userId = actorId(values);
  const amount = fromCents(toCents(values.amount));

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordRemittance",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      if (claim.status === "draft") {
        throw new Error("Submit the claim before recording a remittance");
      }
      if (claim.status === "closed") throw new Error("This claim is closed");

      const target = toCents(claim.approvedAmount) > 0 ? claim.approvedAmount : claim.total;
      const outstandingCents = Math.max(0, toCents(target) - toCents(claim.paidAmount));
      if (toCents(amount) > outstandingCents) {
        throw new Error(
          `The remittance exceeds the outstanding balance of ${fromCents(outstandingCents)}`,
        );
      }

      const facility = await loadFacilityForNumbering(tx, values.facilityId);
      const remittanceNo = await nextFormattedNumber(tx, facility, "remittance");
      const remittanceId = newId();
      const receivedAt = values.receivedAt ?? new Date();

      await tx.insert(remittances).values({
        id: remittanceId,
        facilityId: values.facilityId,
        claimId: claim.id,
        claimLineId: values.claimLineId ?? null,
        remittanceNo,
        amount,
        receivedAt,
        reference: values.reference?.trim() || null,
        createdBy: userId,
      });

      const paidAmount = fromCents(toCents(claim.paidAmount) + toCents(amount));
      const settled = toCents(paidAmount) >= toCents(target);
      const status: ClaimStatus = settled ? "paid" : claim.status;

      await tx
        .update(claims)
        .set({
          paidAmount,
          status,
          resolvedAt: settled ? receivedAt : claim.resolvedAt,
          updatedAt: new Date(),
          version: sql`${claims.version} + 1`,
        })
        .where(and(eq(claims.id, claim.id), eq(claims.facilityId, values.facilityId)));

      const journal = await tryPostJournal(tx, {
        facilityId: values.facilityId,
        entryDate: receivedAt.toISOString().slice(0, 10),
        description: `Remittance ${remittanceNo} for claim ${claim.claimNo}`,
        sourceType: "remittance",
        sourceId: remittanceId,
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
        lines: [
          { systemRole: "bank", debit: amount, description: `Deposit ${remittanceNo}` },
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
        action: "remittance.record",
        module: "revenue",
        entity: "remittances",
        entityId: remittanceId,
        details: {
          remittanceNo,
          claimNo: claim.claimNo,
          amount,
          paidAmount,
          status,
          journalEntryNo: journal?.entryNo ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "remittance.recorded",
        facilityId: values.facilityId,
        remittanceId,
        remittanceNo,
        claimId: claim.id,
        amount,
        status,
      });

      return {
        remittanceId,
        remittanceNo,
        claimId: claim.id,
        claimNo: claim.claimNo,
        amount,
        paidAmount,
        outstanding: claimOutstanding(target, paidAmount),
        status,
        journalEntryNo: journal?.entryNo ?? null,
      };
    },
    options,
  );
}

export const recordClaimDenialSchema = z.object({
  ...baseSchema,
  claimId: z.uuid(),
  claimLineId: z.uuid().nullable().optional(),
  amount: money.optional(),
  reason: z.string().trim().min(1, "A denial reason is required").max(500),
});

export type RecordClaimDenialInput = z.input<typeof recordClaimDenialSchema>;
export interface ClaimDenialResult {
  denialId: string;
  claimId: string;
  amount: string;
  reason: string;
  status: string;
}

export async function recordClaimDenial(
  input: RecordClaimDenialInput,
  options: CommandOptions = {},
): Promise<ClaimDenialResult> {
  const values = recordClaimDenialSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordClaimDenial",
    async (tx) => {
      const claim = await loadClaim(tx, values.facilityId, values.claimId);
      const amount = values.amount ?? claim.total;
      const denialId = newId();

      await tx.insert(claimDenials).values({
        id: denialId,
        facilityId: values.facilityId,
        claimId: claim.id,
        claimLineId: values.claimLineId ?? null,
        amount,
        reason: values.reason,
        status: "open",
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "claim_denial.record",
        module: "revenue",
        entity: "claim_denials",
        entityId: denialId,
        details: { claimNo: claim.claimNo, amount, reason: values.reason },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "claim_denial.recorded",
        facilityId: values.facilityId,
        denialId,
        claimId: claim.id,
        amount,
        reason: values.reason,
      });

      return { denialId, claimId: claim.id, amount, reason: values.reason, status: "open" };
    },
    options,
  );
}

export const resolveClaimDenialSchema = z.object({
  ...baseSchema,
  denialId: z.uuid(),
  status: z.enum(["upheld", "overturned"]),
  resolutionNote: z.string().trim().max(1_000).nullable().optional(),
});

export type ResolveClaimDenialInput = z.input<typeof resolveClaimDenialSchema>;
export interface ResolveClaimDenialResult {
  denialId: string;
  claimId: string;
  status: string;
}

export async function resolveClaimDenial(
  input: ResolveClaimDenialInput,
  options: CommandOptions = {},
): Promise<ResolveClaimDenialResult> {
  const values = resolveClaimDenialSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "resolveClaimDenial",
    async (tx) => {
      const rows = await tx
        .select()
        .from(claimDenials)
        .where(
          and(
            eq(claimDenials.id, values.denialId),
            eq(claimDenials.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const denial = rows[0];
      if (!denial) throw new Error("Denial not found in this facility");
      if (denial.status !== "open") throw new Error(`This denial is already ${denial.status}`);

      const now = new Date();
      await tx
        .update(claimDenials)
        .set({
          status: values.status,
          resolutionNote: values.resolutionNote?.trim() || null,
          resolvedAt: now,
          resolvedBy: userId,
        })
        .where(
          and(eq(claimDenials.id, denial.id), eq(claimDenials.facilityId, values.facilityId)),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "claim_denial.resolve",
        module: "revenue",
        entity: "claim_denials",
        entityId: denial.id,
        details: {
          claimId: denial.claimId,
          status: values.status,
          resolutionNote: values.resolutionNote ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { denialId: denial.id, claimId: denial.claimId, status: values.status };
    },
    options,
  );
}

