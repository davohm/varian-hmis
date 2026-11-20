import { and, desc, eq, getTableColumns, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import {
  BREACH_SEVERITIES,
  BREACH_STATUSES,
  CONSENT_TYPES,
  DSAR_STATUSES,
  DSAR_TYPES,
  PATIENT_RESTRICTION_ENTITY,
  addDaysToTimestamp,
  isConsentValid,
} from "@/lib/privacy";
import { ForbiddenError } from "@/server/auth/rbac";
import { recordAudit } from "@/server/audit";
import { allocateNumber } from "@/server/numbering";
import { db } from "@/server/db/client";
import {
  auditLog,
  chartAccessLog,
  dataBreaches,
  dataConsents,
  dataSharingAgreements,
  dataSubjectRequests,
  encounters,
  facilities,
  facilitySettings,
  invoices,
  patients,
  payments,
  retentionPolicies,
  staffRoleScopes,
  transferAssessments,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";

import {
  actorSchema,
  runCommand,
  type CommandOptions,
  type CommandTransaction,
} from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableIsoDateTime = isoDateTime.nullable().optional();
const nullableIsoDate = isoDate.nullable().optional();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export class PrivacyRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyRefusalError";
  }
}

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

function auditMeta(values: {
  facilityId: string;
  actor: { userId?: string | null; ip?: string | null; deviceId?: string | null };
}) {
  return {
    facilityId: values.facilityId,
    userId: values.actor.userId ?? null,
    module: "privacy",
    deviceId: values.actor.deviceId ?? null,
    ip: values.actor.ip ?? null,
  } as const;
}

async function getPrivacySettingInt(
  tx: CommandTransaction,
  facilityId: string,
  key: "dsar_sla_days" | "breach_notification_hours" | "consent_validity_months",
  fallback: number,
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await tx
    .select({ valueText: facilitySettings.valueText, valueNumeric: facilitySettings.valueNumeric })
    .from(facilitySettings)
    .where(
      and(
        eq(facilitySettings.facilityId, facilityId),
        eq(facilitySettings.domain, "privacy"),
        eq(facilitySettings.key, key),
        sql`${facilitySettings.effectiveFrom} <= ${today}::date`,
        sql`(${facilitySettings.effectiveTo} IS NULL OR ${facilitySettings.effectiveTo} >= ${today}::date)`,
      ),
    )
    .orderBy(desc(facilitySettings.effectiveFrom))
    .limit(1);
  const row = rows[0];
  const raw = row?.valueNumeric ?? row?.valueText;
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

async function getFacilityCode(tx: CommandTransaction, facilityId: string): Promise<string> {
  const rows = await tx
    .select({ code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  const code = rows[0]?.code;
  if (!code) throw new Error("Facility not found");
  return code;
}

async function assertPatientInFacility(tx: CommandTransaction, facilityId: string, patientId: string) {
  const rows = await tx
    .select({ id: patients.id, dob: patients.dob })
    .from(patients)
    .where(and(eq(patients.id, patientId), eq(patients.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new Error("Patient not found in this facility");
  return rows[0];
}

async function assertActorIsDpoOrAdmin(tx: CommandTransaction, facilityId: string, userId: string) {
  const rows = await tx
    .select({ role: staffRoleScopes.role })
    .from(staffRoleScopes)
    .where(and(eq(staffRoleScopes.userId, userId), eq(staffRoleScopes.facilityId, facilityId)));
  const ok = rows.some((r) => r.role === "admin" || r.role === "dpo");
  if (!ok) {
    throw new ForbiddenError("Only a data protection officer or administrator may perform this action");
  }
}

async function assertUserCanAccessFacility(tx: CommandTransaction, facilityId: string, userId: string) {
  const rows = await tx
    .select({ role: staffRoleScopes.role })
    .from(staffRoleScopes)
    .where(and(eq(staffRoleScopes.userId, userId), eq(staffRoleScopes.facilityId, facilityId)));
  if (rows.length === 0) throw new ForbiddenError("You do not have access to this facility");
  return rows;
}

export async function isPatientRestricted(
  tx: CommandTransaction,
  facilityId: string,
  patientId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: retentionPolicies.id })
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.facilityId, facilityId),
        eq(retentionPolicies.entity, PATIENT_RESTRICTION_ENTITY),
        eq(retentionPolicies.triggerEvent, patientId),
        eq(retentionPolicies.legalHold, true),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

async function ensurePatientRestriction(
  tx: CommandTransaction,
  values: {
    facilityId: string;
    patientId: string;
    actor: { userId?: string | null; ip?: string | null; deviceId?: string | null };
    legalBasis?: string | null;
  },
) {
  const existing = await tx
    .select({ id: retentionPolicies.id })
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.facilityId, values.facilityId),
        eq(retentionPolicies.entity, PATIENT_RESTRICTION_ENTITY),
        eq(retentionPolicies.triggerEvent, values.patientId),
      ),
    )
    .limit(1)
    .for("update");
  if (existing[0]) {
    await tx
      .update(retentionPolicies)
      .set({
        legalHold: true,
        legalBasis: values.legalBasis ?? "restricted",
        updatedAt: new Date(),
        version: sql`${retentionPolicies.version} + 1`,
      })
      .where(eq(retentionPolicies.id, existing[0].id));
    return existing[0].id;
  }
  const inserted = await tx
    .insert(retentionPolicies)
    .values({
      facilityId: values.facilityId,
      entity: PATIENT_RESTRICTION_ENTITY,
      triggerEvent: values.patientId,
      legalBasis: values.legalBasis ?? "restricted",
      legalHold: true,
      createdBy: values.actor.userId ?? null,
    })
    .returning({ id: retentionPolicies.id });
  return inserted[0]!.id;
}

async function findLatestValidConsent(
  tx: CommandTransaction,
  facilityId: string,
  patientId: string,
  consentType: string,
  onDate: Date = new Date(),
) {
  const rows = await tx
    .select()
    .from(dataConsents)
    .where(
      and(
        eq(dataConsents.facilityId, facilityId),
        eq(dataConsents.patientId, patientId),
        eq(dataConsents.consentType, consentType),
      ),
    )
    .orderBy(desc(dataConsents.createdAt), desc(dataConsents.version));
  for (const row of rows) {
    if (isConsentValid(row, onDate)) return row;
  }
  return null;
}

/** Throws and audits refusal when no valid payer_sharing consent exists. */
export async function assertValidPayerSharingConsent(
  tx: CommandTransaction,
  values: {
    facilityId: string;
    patientId: string;
    actor: { userId?: string | null; ip?: string | null; deviceId?: string | null };
    action: string;
    entity: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
    sharingAgreementId?: string | null;
  },
) {
  await assertPatientInFacility(tx, values.facilityId, values.patientId);
  const today = new Date().toISOString().slice(0, 10);
  if (values.sharingAgreementId) {
    await assertSharingAgreementUsableForPayer(tx, values.facilityId, values.sharingAgreementId, today);
  }
  const valid = await findLatestValidConsent(tx, values.facilityId, values.patientId, "payer_sharing");
  if (!valid) {
    await recordAudit(tx, {
      ...auditMeta(values),
      action: values.action,
      entity: values.entity,
      entityId: values.entityId ?? null,
      details: {
        ...(values.details ?? {}),
        refused: true,
        reason: "missing_or_invalid_payer_sharing_consent",
      },
    });
    throw new PrivacyRefusalError("A valid payer sharing consent is required before sharing patient data with a payer");
  }
  return valid;
}

function isMinorDob(dob: string | Date | null | undefined, onDate: Date = new Date()): boolean {
  if (!dob) return false;
  const birth = typeof dob === "string" ? new Date(`${dob}T00:00:00Z`) : dob;
  if (Number.isNaN(birth.getTime())) return false;
  const ageMs = onDate.getTime() - birth.getTime();
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  return ageYears < 18;
}

/** For minors, a valid guardian/minor consent record is required for treatment. */
export async function assertMinorTreatmentConsent(
  tx: CommandTransaction,
  values: {
    facilityId: string;
    patientId: string;
    actor?: { userId?: string | null; ip?: string | null; deviceId?: string | null };
  },
) {
  const patient = await assertPatientInFacility(tx, values.facilityId, values.patientId);
  if (!isMinorDob(patient.dob)) return null;
  const guardian = await findLatestValidConsent(tx, values.facilityId, values.patientId, "minor");
  if (!guardian) {
    if (values.actor) {
      await recordAudit(tx, {
        ...auditMeta({ facilityId: values.facilityId, actor: values.actor }),
        action: "privacy.consent.treatment_minor_refused",
        entity: "patients",
        entityId: values.patientId,
        details: { refused: true, reason: "missing_guardian_minor_consent" },
      });
    }
    throw new PrivacyRefusalError("A minor's treatment consent requires a guardian consent record");
  }
  return guardian;
}

async function assertSharingAgreementUsableForPayer(
  tx: CommandTransaction,
  facilityId: string,
  agreementId: string | null | undefined,
  today: string,
) {
  if (!agreementId) return;
  const rows = await tx
    .select()
    .from(dataSharingAgreements)
    .where(and(eq(dataSharingAgreements.id, agreementId), eq(dataSharingAgreements.facilityId, facilityId)))
    .limit(1);
  const agreement = rows[0];
  if (!agreement) throw new Error("Sharing agreement not found in this facility");
  if (agreement.expiresOn && String(agreement.expiresOn) < today) {
    throw new PrivacyRefusalError("A sharing agreement past its expiry cannot be used for a new payer data share");
  }
  if (agreement.status && agreement.status !== "active") {
    throw new PrivacyRefusalError("Only active sharing agreements can be used for a new payer data share");
  }
}

/* ------------------------------------------------------------------ */
/* Consents                                                            */
/* ------------------------------------------------------------------ */

export const recordConsentSchema = z
  .object({
    ...baseSchema,
    patientId: z.uuid(),
    consentType: z.enum(CONSENT_TYPES),
    consentVersion: z.string().trim().min(1).max(64),
    consentTextHash: nullableText(128),
    granted: z.boolean(),
    grantedAt: nullableIsoDateTime,
    grantedBy: nullableText(128),
    source: nullableText(64),
    documentId: z.uuid().nullable().optional(),
    validFrom: nullableIsoDateTime,
    validTo: nullableIsoDateTime,
  })
  .superRefine((v, ctx) => {
    if (v.granted && !v.grantedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "grantedAt is required when consent is granted",
        path: ["grantedAt"],
      });
    }
  });

export type RecordConsentInput = z.input<typeof recordConsentSchema>;
export interface RecordConsentResult {
  consentId: string;
  patientId: string;
  consentType: string;
  consentVersion: string;
  granted: boolean;
  supersededConsentIds: string[];
}

export async function recordConsent(
  input: RecordConsentInput,
  options: CommandOptions = {},
): Promise<RecordConsentResult> {
  const values = recordConsentSchema.parse(input);
  actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordConsent",
    async (tx) => {
      await assertPatientInFacility(tx, values.facilityId, values.patientId);

      // New version supersedes previous versions for this type for new processing.
      const previous = await tx
        .select({ id: dataConsents.id, validTo: dataConsents.validTo })
        .from(dataConsents)
        .where(
          and(
            eq(dataConsents.facilityId, values.facilityId),
            eq(dataConsents.patientId, values.patientId),
            eq(dataConsents.consentType, values.consentType),
            ne(dataConsents.consentVersion, values.consentVersion),
            isNull(dataConsents.withdrawnAt),
          ),
        )
        .for("update");
      const supersededConsentIds = previous.map((row) => row.id);
      if (supersededConsentIds.length > 0) {
        const supersededAt = new Date(Date.now() - 1000);
        for (const row of previous) {
          const currentValidTo = row.validTo ? new Date(row.validTo) : null;
          const nextValidTo = !currentValidTo || currentValidTo > supersededAt ? supersededAt : currentValidTo;
          await tx
            .update(dataConsents)
            .set({
              validTo: nextValidTo,
              updatedAt: new Date(),
              version: sql`${dataConsents.version} + 1`,
            })
            .where(eq(dataConsents.id, row.id));
        }
      }

      const inserted = await tx
        .insert(dataConsents)
        .values({
          facilityId: values.facilityId,
          patientId: values.patientId,
          consentType: values.consentType,
          consentVersion: values.consentVersion,
          consentTextHash: values.consentTextHash ?? null,
          granted: values.granted,
          grantedAt: values.grantedAt ? new Date(values.grantedAt) : null,
          grantedBy: values.grantedBy ?? values.actor.userId ?? null,
          withdrawnAt: null,
          withdrawnBy: null,
          source: values.source ?? null,
          documentId: values.documentId ?? null,
          validFrom: values.validFrom ? new Date(values.validFrom) : null,
          validTo: values.validTo ? new Date(values.validTo) : null,
          createdBy: values.actor.userId ?? null,
        })
        .returning({ id: dataConsents.id });
      const consentId = inserted[0]!.id;

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.consent.record",
        entity: "data_consents",
        entityId: consentId,
        details: {
          patientId: values.patientId,
          consentType: values.consentType,
          consentVersion: values.consentVersion,
          granted: values.granted,
          supersededConsentIds,
        },
      });

      await publishEvent(tx, {
        type: "privacy.consent.recorded",
        facilityId: values.facilityId,
        patientId: values.patientId,
        consentType: values.consentType,
        consentVersion: values.consentVersion,
      });

      return {
        consentId,
        patientId: values.patientId,
        consentType: values.consentType,
        consentVersion: values.consentVersion,
        granted: values.granted,
        supersededConsentIds,
      };
    },
    options,
  );
}

export const withdrawConsentSchema = z.object({
  ...baseSchema,
  consentId: z.uuid(),
  withdrawnAt: isoDateTime.optional(),
});

export type WithdrawConsentInput = z.input<typeof withdrawConsentSchema>;
export interface WithdrawConsentResult {
  consentId: string;
  patientId: string;
  consentType: string;
  withdrawnAt: string;
}

export async function withdrawConsent(
  input: WithdrawConsentInput,
  options: CommandOptions = {},
): Promise<WithdrawConsentResult> {
  const values = withdrawConsentSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "withdrawConsent",
    async (tx) => {
      const rows = await tx
        .select()
        .from(dataConsents)
        .where(and(eq(dataConsents.id, values.consentId), eq(dataConsents.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const consent = rows[0];
      if (!consent) throw new Error("Consent not found in this facility");
      if (consent.withdrawnAt) {
        throw new Error("A withdrawn consent cannot be un-withdrawn; record a new consent instead");
      }

      const withdrawnAt = values.withdrawnAt ? new Date(values.withdrawnAt) : new Date();
      await tx
        .update(dataConsents)
        .set({
          withdrawnAt,
          withdrawnBy: userId,
          updatedAt: new Date(),
          version: sql`${dataConsents.version} + 1`,
        })
        .where(eq(dataConsents.id, consent.id));

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.consent.withdraw",
        entity: "data_consents",
        entityId: consent.id,
        details: {
          patientId: consent.patientId,
          consentType: consent.consentType,
          consentVersion: consent.consentVersion,
          withdrawnAt: withdrawnAt.toISOString(),
        },
      });

      await publishEvent(tx, {
        type: "privacy.consent.withdrawn",
        facilityId: values.facilityId,
        patientId: consent.patientId,
        consentType: consent.consentType,
      });

      return {
        consentId: consent.id,
        patientId: consent.patientId,
        consentType: consent.consentType,
        withdrawnAt: withdrawnAt.toISOString(),
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Data subject requests                                               */
/* ------------------------------------------------------------------ */

export const createDataSubjectRequestSchema = z
  .object({
    ...baseSchema,
    patientId: z.uuid(),
    requestType: z.enum(DSAR_TYPES),
    status: z.enum(DSAR_STATUSES).optional().default("received"),
    receivedAt: isoDateTime.optional(),
    requestedVia: nullableText(64),
    identityVerified: z.boolean().optional().default(false),
    verifiedBy: nullableText(128),
    notes: nullableText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.status === "in_progress" && !v.identityVerified) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Identity must be verified before a request moves to in_progress",
        path: ["identityVerified"],
      });
    }
    if (v.status === "completed" || v.status === "rejected") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Complete or reject a request with completeDataSubjectRequest",
        path: ["status"],
      });
    }
  });

export type CreateDataSubjectRequestInput = z.input<typeof createDataSubjectRequestSchema>;
export interface CreateDataSubjectRequestResult {
  requestId: string;
  patientId: string;
  requestType: string;
  status: string;
  receivedAt: string;
  dueAt: string;
}

export async function createDataSubjectRequest(
  input: CreateDataSubjectRequestInput,
  options: CommandOptions = {},
): Promise<CreateDataSubjectRequestResult> {
  const values = createDataSubjectRequestSchema.parse(input);
  actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createDataSubjectRequest",
    async (tx) => {
      await assertPatientInFacility(tx, values.facilityId, values.patientId);
      const receivedAt = values.receivedAt ? new Date(values.receivedAt) : new Date();
      const slaDays = await getPrivacySettingInt(tx, values.facilityId, "dsar_sla_days", 30);
      const dueAt = addDaysToTimestamp(receivedAt, slaDays);
      const status = values.status ?? "received";

      const inserted = await tx
        .insert(dataSubjectRequests)
        .values({
          facilityId: values.facilityId,
          patientId: values.patientId,
          requestType: values.requestType,
          status,
          receivedAt,
          dueAt,
          completedAt: null,
          requestedVia: values.requestedVia ?? null,
          identityVerified: values.identityVerified ?? false,
          verifiedBy: values.identityVerified ? (values.verifiedBy ?? values.actor.userId ?? null) : null,
          outcome: null,
          rejectionReason: null,
          handledBy: values.actor.userId ?? null,
          notes: values.notes ?? null,
          createdBy: values.actor.userId ?? null,
        })
        .returning({ id: dataSubjectRequests.id });
      const requestId = inserted[0]!.id;

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.dsar.create",
        entity: "data_subject_requests",
        entityId: requestId,
        details: {
          patientId: values.patientId,
          requestType: values.requestType,
          status,
          receivedAt: receivedAt.toISOString(),
          dueAt: dueAt.toISOString(),
          slaDays,
        },
      });

      await publishEvent(tx, {
        type: "privacy.dsar.created",
        facilityId: values.facilityId,
        requestId,
        patientId: values.patientId,
        requestType: values.requestType,
      });

      return {
        requestId,
        patientId: values.patientId,
        requestType: values.requestType,
        status,
        receivedAt: receivedAt.toISOString(),
        dueAt: dueAt.toISOString(),
      };
    },
    options,
  );
}

export const completeDataSubjectRequestSchema = z
  .object({
    ...baseSchema,
    requestId: z.uuid(),
    status: z.enum(["completed", "rejected", "in_progress", "verifying", "received"]),
    outcome: nullableText(2000),
    rejectionReason: nullableText(2000),
    identityVerified: z.boolean().optional(),
    completedAt: nullableIsoDateTime,
    notes: nullableText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.status === "completed" && (!v.outcome || v.outcome.trim().length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Outcome is required to complete a request", path: ["outcome"] });
    }
    if (
      v.status === "rejected" &&
      (!v.outcome || v.outcome.trim().length === 0) &&
      (!v.rejectionReason || v.rejectionReason.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Outcome or rejection reason is required to reject a request",
        path: ["outcome"],
      });
    }
    if (v.status === "in_progress" && v.identityVerified === false) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Identity must be verified before in_progress", path: ["identityVerified"] });
    }
  });

export type CompleteDataSubjectRequestInput = z.input<typeof completeDataSubjectRequestSchema>;
export interface CompleteDataSubjectRequestResult {
  requestId: string;
  patientId: string;
  status: string;
  outcome: string | null;
  completedAt: string | null;
  restrictionCreated: boolean;
}

export async function completeDataSubjectRequest(
  input: CompleteDataSubjectRequestInput,
  options: CommandOptions = {},
): Promise<CompleteDataSubjectRequestResult> {
  const values = completeDataSubjectRequestSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "completeDataSubjectRequest",
    async (tx) => {
      const rows = await tx
        .select()
        .from(dataSubjectRequests)
        .where(and(eq(dataSubjectRequests.id, values.requestId), eq(dataSubjectRequests.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const request = rows[0];
      if (!request) throw new Error("Data subject request not found in this facility");

      const identityVerified = values.identityVerified ?? request.identityVerified;
      if (values.status === "in_progress" && !identityVerified) {
        throw new Error("Identity must be verified before a request moves to in_progress");
      }

      let restrictionCreated = false;
      const outcome = values.outcome === undefined ? request.outcome : (values.outcome ?? null);
      if (values.status === "completed") {
        if (!outcome || outcome.trim().length === 0) throw new Error("Outcome is required to complete a request");
        if (request.requestType === "erasure") {
          await ensurePatientRestriction(tx, {
            facilityId: values.facilityId,
            patientId: request.patientId,
            actor: values.actor,
            legalBasis: "erasure_request",
          });
          restrictionCreated = true;
        }
      }

      const completedAt =
        values.status === "completed" || values.status === "rejected"
          ? (values.completedAt ? new Date(values.completedAt) : new Date())
          : (values.completedAt ? new Date(values.completedAt) : request.completedAt);

      await tx
        .update(dataSubjectRequests)
        .set({
          status: values.status,
          outcome,
          rejectionReason:
            values.rejectionReason === undefined ? request.rejectionReason : (values.rejectionReason ?? null),
          identityVerified,
          verifiedBy: identityVerified ? (request.verifiedBy ?? userId) : request.verifiedBy,
          handledBy: userId,
          completedAt,
          notes: values.notes === undefined ? request.notes : (values.notes ?? null),
          updatedAt: new Date(),
          version: sql`${dataSubjectRequests.version} + 1`,
        })
        .where(eq(dataSubjectRequests.id, request.id));

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.dsar.complete",
        entity: "data_subject_requests",
        entityId: request.id,
        details: {
          patientId: request.patientId,
          requestType: request.requestType,
          status: values.status,
          outcome,
          restrictionCreated,
        },
      });

      await publishEvent(tx, {
        type: "privacy.dsar.updated",
        facilityId: values.facilityId,
        requestId: request.id,
        patientId: request.patientId,
        status: values.status,
      });

      return {
        requestId: request.id,
        patientId: request.patientId,
        status: values.status,
        outcome,
        completedAt: completedAt ? completedAt.toISOString() : null,
        restrictionCreated,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Breaches                                                            */
/* ------------------------------------------------------------------ */

export const recordBreachSchema = z
  .object({
    ...baseSchema,
    discoveredAt: isoDateTime,
    containedAt: nullableIsoDateTime,
    odpcNotifiedAt: nullableIsoDateTime,
    affectedSubjects: z.number().int().min(0),
    affectedRecords: z.number().int().min(0).nullable().optional(),
    severity: z.enum(BREACH_SEVERITIES),
    description: nullableText(4000),
    containment: nullableText(4000),
    rootCause: nullableText(4000),
    status: z.enum(BREACH_STATUSES).optional().default("open"),
    reportedBy: nullableText(128),
    odpcReference: nullableText(128),
  })
  .superRefine((v, ctx) => {
    if (v.odpcNotifiedAt) {
      const discovered = new Date(v.discoveredAt).getTime();
      const notified = new Date(v.odpcNotifiedAt).getTime();
      if (notified < discovered) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A breach cannot be marked notified before discovery",
          path: ["odpcNotifiedAt"],
        });
      }
    }
  });

export type RecordBreachInput = z.input<typeof recordBreachSchema>;
export interface RecordBreachResult {
  breachId: string;
  reference: string;
  severity: string;
  status: string;
  discoveredAt: string;
}

export async function recordBreach(
  input: RecordBreachInput,
  options: CommandOptions = {},
): Promise<RecordBreachResult> {
  const values = recordBreachSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordBreach",
    async (tx) => {
      const discoveredAt = new Date(values.discoveredAt);
      const odpcNotifiedAt = values.odpcNotifiedAt ? new Date(values.odpcNotifiedAt) : null;
      if (odpcNotifiedAt && odpcNotifiedAt.getTime() < discoveredAt.getTime()) {
        throw new Error("A breach cannot be marked notified before discovery");
      }

      const facilityCode = await getFacilityCode(tx, values.facilityId);
      const seq = await allocateNumber(tx, values.facilityId, "breach");
      const year = String(discoveredAt.getUTCFullYear()).slice(-2);
      const reference = `${facilityCode}-BR-${year}-${String(seq).padStart(5, "0")}`;

      const inserted = await tx
        .insert(dataBreaches)
        .values({
          facilityId: values.facilityId,
          reference,
          discoveredAt,
          containedAt: values.containedAt ? new Date(values.containedAt) : null,
          odpcNotifiedAt,
          affectedSubjects: values.affectedSubjects,
          affectedRecords: values.affectedRecords ?? null,
          severity: values.severity,
          description: values.description ?? null,
          containment: values.containment ?? null,
          rootCause: values.rootCause ?? null,
          status: values.status ?? "open",
          reportedBy: values.reportedBy ?? userId,
          odpcReference: values.odpcReference ?? null,
          createdBy: userId,
        })
        .returning({ id: dataBreaches.id });
      const breachId = inserted[0]!.id;

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.breach.record",
        entity: "data_breaches",
        entityId: breachId,
        details: {
          reference,
          severity: values.severity,
          affectedSubjects: values.affectedSubjects,
          status: values.status ?? "open",
        },
      });

      await publishEvent(tx, {
        type: "privacy.breach.recorded",
        facilityId: values.facilityId,
        breachId,
        reference,
        severity: values.severity,
      });

      return {
        breachId,
        reference,
        severity: values.severity,
        status: values.status ?? "open",
        discoveredAt: discoveredAt.toISOString(),
      };
    },
    options,
  );
}

export const notifyBreachSchema = z.object({
  ...baseSchema,
  breachId: z.uuid(),
  odpcNotifiedAt: isoDateTime.optional(),
  odpcReference: nullableText(128),
});

export type NotifyBreachInput = z.input<typeof notifyBreachSchema>;
export interface NotifyBreachResult {
  breachId: string;
  reference: string;
  odpcNotifiedAt: string;
  odpcReference: string | null;
  notifiedBy: string;
}

export async function notifyBreach(
  input: NotifyBreachInput,
  options: CommandOptions = {},
): Promise<NotifyBreachResult> {
  const values = notifyBreachSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "notifyBreach",
    async (tx) => {
      const rows = await tx
        .select()
        .from(dataBreaches)
        .where(and(eq(dataBreaches.id, values.breachId), eq(dataBreaches.facilityId, values.facilityId)))
        .limit(1)
        .for("update");
      const breach = rows[0];
      if (!breach) throw new Error("Breach not found in this facility");

      const odpcNotifiedAt = values.odpcNotifiedAt ? new Date(values.odpcNotifiedAt) : new Date();
      if (odpcNotifiedAt.getTime() < breach.discoveredAt.getTime()) {
        throw new Error("A breach cannot be marked notified before discovery");
      }

      await tx
        .update(dataBreaches)
        .set({
          odpcNotifiedAt,
          odpcReference: values.odpcReference === undefined ? breach.odpcReference : (values.odpcReference ?? null),
          status: breach.status === "open" || breach.status === "contained" ? "notified" : breach.status,
          updatedAt: new Date(),
          version: sql`${dataBreaches.version} + 1`,
        })
        .where(eq(dataBreaches.id, breach.id));

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.breach.notify",
        entity: "data_breaches",
        entityId: breach.id,
        details: {
          reference: breach.reference,
          odpcNotifiedAt: odpcNotifiedAt.toISOString(),
          odpcReference: values.odpcReference ?? breach.odpcReference,
          notifiedBy: userId,
        },
      });

      await publishEvent(tx, {
        type: "privacy.breach.notified",
        facilityId: values.facilityId,
        breachId: breach.id,
        reference: breach.reference,
      });

      return {
        breachId: breach.id,
        reference: breach.reference,
        odpcNotifiedAt: odpcNotifiedAt.toISOString(),
        odpcReference: values.odpcReference === undefined ? breach.odpcReference : (values.odpcReference ?? null),
        notifiedBy: userId,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Sharing agreements and transfer assessments                         */
/* ------------------------------------------------------------------ */

export const createSharingAgreementSchema = z
  .object({
    ...baseSchema,
    counterparty: z.string().trim().min(1).max(200),
    counterpartyType: z.string().trim().min(1).max(64),
    purpose: nullableText(2000),
    lawfulBasis: z.string().trim().min(1).max(500),
    odpcReference: nullableText(128),
    startedOn: nullableIsoDate,
    expiresOn: nullableIsoDate,
    status: nullableText(32),
    documentId: z.uuid().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.counterpartyType === "processor" && !v.expiresOn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expiry is required for processor agreements", path: ["expiresOn"] });
    }
  });

export type CreateSharingAgreementInput = z.input<typeof createSharingAgreementSchema>;
export interface CreateSharingAgreementResult {
  agreementId: string;
  counterparty: string;
  counterpartyType: string;
  expiresOn: string | null;
}

export async function createSharingAgreement(
  input: CreateSharingAgreementInput,
  options: CommandOptions = {},
): Promise<CreateSharingAgreementResult> {
  const values = createSharingAgreementSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createSharingAgreement",
    async (tx) => {
      const inserted = await tx
        .insert(dataSharingAgreements)
        .values({
          facilityId: values.facilityId,
          counterparty: values.counterparty,
          counterpartyType: values.counterpartyType,
          purpose: values.purpose ?? null,
          lawfulBasis: values.lawfulBasis,
          odpcReference: values.odpcReference ?? null,
          startedOn: values.startedOn ?? null,
          expiresOn: values.expiresOn ?? null,
          status: values.status ?? "active",
          documentId: values.documentId ?? null,
          createdBy: userId,
        })
        .returning({ id: dataSharingAgreements.id });
      const agreementId = inserted[0]!.id;

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.sharing_agreement.create",
        entity: "data_sharing_agreements",
        entityId: agreementId,
        details: { counterparty: values.counterparty, counterpartyType: values.counterpartyType, expiresOn: values.expiresOn ?? null },
      });

      await publishEvent(tx, {
        type: "privacy.sharing_agreement.created",
        facilityId: values.facilityId,
        agreementId,
      });

      return { agreementId, counterparty: values.counterparty, counterpartyType: values.counterpartyType, expiresOn: values.expiresOn ?? null };
    },
    options,
  );
}

export const recordTransferAssessmentSchema = z.object({
  ...baseSchema,
  transferPath: nullableText(500),
  destinationCountry: z.string().trim().min(1).max(120),
  mechanism: z.string().trim().min(1).max(200),
  lawfulBasis: nullableText(500),
  assessmentDate: nullableIsoDate,
  reviewDate: isoDate,
  status: nullableText(32),
  approvedBy: nullableText(128),
});

export type RecordTransferAssessmentInput = z.input<typeof recordTransferAssessmentSchema>;
export interface RecordTransferAssessmentResult {
  assessmentId: string;
  destinationCountry: string;
  mechanism: string;
  reviewDate: string;
}

export async function recordTransferAssessment(
  input: RecordTransferAssessmentInput,
  options: CommandOptions = {},
): Promise<RecordTransferAssessmentResult> {
  const values = recordTransferAssessmentSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordTransferAssessment",
    async (tx) => {
      const inserted = await tx
        .insert(transferAssessments)
        .values({
          facilityId: values.facilityId,
          transferPath: values.transferPath ?? null,
          destinationCountry: values.destinationCountry,
          mechanism: values.mechanism,
          lawfulBasis: values.lawfulBasis ?? null,
          assessmentDate: values.assessmentDate ?? null,
          reviewDate: values.reviewDate,
          status: values.status ?? "recorded",
          approvedBy: values.approvedBy ?? userId,
          createdBy: userId,
        })
        .returning({ id: transferAssessments.id });
      const assessmentId = inserted[0]!.id;

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.transfer_assessment.record",
        entity: "transfer_assessments",
        entityId: assessmentId,
        details: { destinationCountry: values.destinationCountry, mechanism: values.mechanism, reviewDate: values.reviewDate },
      });

      await publishEvent(tx, {
        type: "privacy.transfer_assessment.recorded",
        facilityId: values.facilityId,
        assessmentId,
      });

      return { assessmentId, destinationCountry: values.destinationCountry, mechanism: values.mechanism, reviewDate: values.reviewDate };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Restriction, chart access, export                                   */
/* ------------------------------------------------------------------ */

export const restrictPatientRecordSchema = z.object({
  ...baseSchema,
  patientId: z.uuid(),
  reason: nullableText(500),
});

export type RestrictPatientRecordInput = z.input<typeof restrictPatientRecordSchema>;
export interface RestrictPatientRecordResult {
  patientId: string;
  restricted: boolean;
  restrictionRecordId: string;
}

export async function restrictPatientRecord(
  input: RestrictPatientRecordInput,
  options: CommandOptions = {},
): Promise<RestrictPatientRecordResult> {
  const values = restrictPatientRecordSchema.parse(input);
  actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "restrictPatientRecord",
    async (tx) => {
      await assertPatientInFacility(tx, values.facilityId, values.patientId);
      const restrictionRecordId = await ensurePatientRestriction(tx, {
        facilityId: values.facilityId,
        patientId: values.patientId,
        actor: values.actor,
        legalBasis: values.reason ?? "restricted",
      });

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.patient.restrict",
        entity: "patients",
        entityId: values.patientId,
        details: { restrictionRecordId, reason: values.reason ?? null },
      });

      await publishEvent(tx, {
        type: "privacy.patient.restricted",
        facilityId: values.facilityId,
        patientId: values.patientId,
      });

      return { patientId: values.patientId, restricted: true, restrictionRecordId };
    },
    options,
  );
}

export const logChartAccessSchema = z.object({
  ...baseSchema,
  patientId: z.uuid(),
  accessType: nullableText(64),
  reason: nullableText(500),
});

export type LogChartAccessInput = z.input<typeof logChartAccessSchema>;
export interface LogChartAccessResult {
  accessId: string;
  patientId: string;
  accessedAt: string;
  restricted: boolean;
}

export async function logChartAccess(
  input: LogChartAccessInput,
  options: CommandOptions = {},
): Promise<LogChartAccessResult> {
  const values = logChartAccessSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "logChartAccess",
    async (tx) => {
      await assertUserCanAccessFacility(tx, values.facilityId, userId);
      await assertPatientInFacility(tx, values.facilityId, values.patientId);
      const restricted = await isPatientRestricted(tx, values.facilityId, values.patientId);
      if (restricted && (!values.reason || values.reason.trim().length === 0)) {
        throw new Error("A reason is required to access a restricted patient chart");
      }

      const accessedAt = new Date();
      const inserted = await tx
        .insert(chartAccessLog)
        .values({
          facilityId: values.facilityId,
          patientId: values.patientId,
          userId,
          accessedAt,
          accessType: values.accessType ?? "view",
          deviceId: values.actor.deviceId ?? null,
          ip: values.actor.ip ?? null,
          reason: values.reason ?? null,
          createdBy: userId,
        })
        .returning({ id: chartAccessLog.id });
      const accessId = inserted[0]!.id;

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.chart_access.log",
        entity: "chart_access_log",
        entityId: accessId,
        details: {
          patientId: values.patientId,
          accessType: values.accessType ?? "view",
          restricted,
          reasonProvided: Boolean(values.reason && values.reason.trim().length > 0),
        },
      });

      return { accessId, patientId: values.patientId, accessedAt: accessedAt.toISOString(), restricted };
    },
    options,
  );
}

export const exportPatientDataSchema = z.object({
  ...baseSchema,
  patientId: z.uuid(),
  requestId: z.uuid().nullable().optional(),
});

export type ExportPatientDataInput = z.input<typeof exportPatientDataSchema>;
export interface ExportPatientDataResult {
  exportId: string;
  patientId: string;
  requestId: string | null;
  generatedAt: string;
  counts: {
    encounters: number;
    invoices: number;
    payments: number;
    consents: number;
    audit: number;
  };
  data: {
    patient: Record<string, unknown> | null;
    encounters: Array<Record<string, unknown>>;
    invoices: Array<Record<string, unknown>>;
    payments: Array<Record<string, unknown>>;
    consents: Array<Record<string, unknown>>;
    audit: Array<Record<string, unknown>>;
  };
}

export async function exportPatientData(
  input: ExportPatientDataInput,
  options: CommandOptions = {},
): Promise<ExportPatientDataResult> {
  const values = exportPatientDataSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "exportPatientData",
    async (tx) => {
      await assertActorIsDpoOrAdmin(tx, values.facilityId, userId);
      await assertPatientInFacility(tx, values.facilityId, values.patientId);

      if (values.requestId) {
        const reqRows = await tx
          .select({ id: dataSubjectRequests.id, patientId: dataSubjectRequests.patientId })
          .from(dataSubjectRequests)
          .where(and(eq(dataSubjectRequests.id, values.requestId), eq(dataSubjectRequests.facilityId, values.facilityId)))
          .limit(1);
        const req = reqRows[0];
        if (!req) throw new Error("Data subject request not found in this facility");
        if (req.patientId !== values.patientId) {
          throw new Error("The data subject request does not belong to this patient");
        }
      }

      const [patientRows, encounterRows, invoiceRows, paymentRows, consentRows, auditRows] = await Promise.all([
        tx
          .select()
          .from(patients)
          .where(and(eq(patients.id, values.patientId), eq(patients.facilityId, values.facilityId)))
          .limit(1),
        tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.patientId, values.patientId), eq(encounters.facilityId, values.facilityId))),
        tx
          .select({ ...getTableColumns(invoices) })
          .from(invoices)
          .innerJoin(encounters, eq(encounters.id, invoices.encounterId))
          .where(and(eq(encounters.patientId, values.patientId), eq(invoices.facilityId, values.facilityId))),
        tx
          .select({ ...getTableColumns(payments) })
          .from(payments)
          .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
          .innerJoin(encounters, eq(encounters.id, invoices.encounterId))
          .where(and(eq(encounters.patientId, values.patientId), eq(payments.facilityId, values.facilityId))),
        tx
          .select()
          .from(dataConsents)
          .where(and(eq(dataConsents.patientId, values.patientId), eq(dataConsents.facilityId, values.facilityId))),
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.entityId, values.patientId), eq(auditLog.facilityId, values.facilityId))),
      ]);

      const generatedAt = new Date().toISOString();
      const counts = {
        encounters: encounterRows.length,
        invoices: invoiceRows.length,
        payments: paymentRows.length,
        consents: consentRows.length,
        audit: auditRows.length,
      };

      const result: ExportPatientDataResult = {
        exportId: values.idempotencyKey,
        patientId: values.patientId,
        requestId: values.requestId ?? null,
        generatedAt,
        counts,
        data: {
          patient: (patientRows[0] as unknown as Record<string, unknown>) ?? null,
          encounters: encounterRows as unknown as Array<Record<string, unknown>>,
          invoices: invoiceRows as unknown as Array<Record<string, unknown>>,
          payments: paymentRows as unknown as Array<Record<string, unknown>>,
          consents: consentRows as unknown as Array<Record<string, unknown>>,
          audit: auditRows as unknown as Array<Record<string, unknown>>,
        },
      };

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "privacy.data.export",
        entity: "patients",
        entityId: values.patientId,
        details: { requestId: values.requestId ?? null, counts },
      });

      return result;
    },
    options,
  );
}

/** Utility for integrations to refuse use of an expired/inactive sharing agreement. */
export async function assertSharingAgreementUsable(
  tx: CommandTransaction,
  facilityId: string,
  agreementId: string,
  today: string = new Date().toISOString().slice(0, 10),
) {
  await assertSharingAgreementUsableForPayer(tx, facilityId, agreementId, today);
}
