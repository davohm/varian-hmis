import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  FACILITY_OWNERSHIPS,
  KMPDC_FACILITY_CATEGORIES,
  LICENCE_STATUSES,
  REGULATORY_DOMAINS,
  SETTING_DOMAINS,
  isValidKraPin,
  licenceStatusFor,
  normalizeKraPin,
  settingDefinition,
  validateSettingValue,
  type ReadinessDomainResult,
  type ReadinessStatus,
  type RegulatoryDomain,
  type SettingDomain,
} from "@/lib/regulatory";
import { ForbiddenError } from "@/server/auth/rbac";
import { recordAudit } from "@/server/audit";
import { db } from "@/server/db/client";
import {
  facilityIdentifiers,
  facilityLicences,
  facilityRegulatoryProfiles,
  facilitySettings,
  integrationSettings,
  licenceAlertRules,
  practitionerRegistrations,
  shaAdjudicationCodes,
  staffProfiles,
  staffRoleScopes,
  statutoryFeeSchedules,
  statutoryRates,
  supportServiceLicences,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { getFacilityReadinessStatus, todayIso } from "@/server/queries/regulatory";

import { actorSchema, runCommand, type CommandActor, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in the form YYYY-MM-DD");

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const money = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Use an amount with at most two decimals");

const regulatorSchema = z.enum(["kmpdc", "ppb", "kmlttb", "nck", "rpb", "other"]);
const licenceStatusSchema = z.enum(LICENCE_STATUSES);
const supportServiceTypeSchema = z.enum([
  "pharmacy",
  "laboratory",
  "imaging",
  "ambulance",
  "mortuary",
  "theatre",
]);
const settingDomainSchema = z.enum(SETTING_DOMAINS as [SettingDomain, ...SettingDomain[]]);
const roleSchema = z.enum([
  "receptionist",
  "triage_nurse",
  "doctor",
  "lab_tech",
  "pharmacist",
  "cashier",
  "accountant",
  "finance_officer",
  "revenue_cycle_officer",
  "auditor",
  "regulatory_officer",
  "admin",
]);

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function auditMeta(values: { facilityId: string; actor: { userId?: string | null; ip?: string | null; deviceId?: string | null } }) {
  return {
    facilityId: values.facilityId,
    userId: values.actor.userId ?? null,
    module: "regulatory",
    deviceId: values.actor.deviceId ?? null,
    ip: values.actor.ip ?? null,
  } as const;
}

/* ------------------------------------------------------------------ */
/* Facility regulatory profile                                         */
/* ------------------------------------------------------------------ */

export const upsertFacilityRegulatoryProfileSchema = z.object({
  ...baseSchema,
  kmpdcNumber: nullableText(64),
  kmhflId: nullableText(64),
  kephLevel: z.number().int().min(1, "KEPH level must be 1 to 6").max(6, "KEPH level must be 1 to 6").nullable().optional(),
  facilityCategory: z.enum(KMPDC_FACILITY_CATEGORIES).nullable().optional(),
  ownership: z.enum(FACILITY_OWNERSHIPS).nullable().optional(),
  county: z.string().trim().min(1, "County is required for MOH reporting").max(100),
  subCounty: z.string().trim().min(1, "Sub-county is required for MOH reporting").max(100),
  constituency: nullableText(100),
  ward: nullableText(100),
  licenceNo: nullableText(64),
  licenceIssueDate: isoDate.nullable().optional(),
  licenceExpiryDate: isoDate.nullable().optional(),
  licenceStatus: licenceStatusSchema.optional(),
  indemnityProvider: nullableText(200),
  indemnityNo: nullableText(64),
  indemnityExpiryDate: isoDate.nullable().optional(),
  shaFacilityCode: nullableText(64),
  shaEmpanelmentStatus: nullableText(32),
  odpcRegistrationNo: nullableText(64),
  odpcCategory: nullableText(100),
  odpcExpiryDate: isoDate.nullable().optional(),
  kraPin: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine(
      (value) => !value || isValidKraPin(value),
      "KRA PIN must be P followed by 9 digits and 1 letter, for example P052292910Q",
    ),
  tccNo: nullableText(64),
  tccExpiryDate: isoDate.nullable().optional(),
  nssfEmployerCode: nullableText(64),
  shifEmployerCode: nullableText(64),
  kemsaSupplierCode: nullableText(64),
});

export type UpsertFacilityRegulatoryProfileInput = z.input<
  typeof upsertFacilityRegulatoryProfileSchema
>;
export interface FacilityRegulatoryProfileResult {
  facilityId: string;
  kraPin: string | null;
  kephLevel: number | null;
  licenceStatus: string;
  licenceExpiryDate: string | null;
}

export async function upsertFacilityRegulatoryProfile(
  input: UpsertFacilityRegulatoryProfileInput,
  options: CommandOptions = {},
): Promise<FacilityRegulatoryProfileResult> {
  const values = upsertFacilityRegulatoryProfileSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertFacilityRegulatoryProfile",
    async (tx) => {
      const existingRows = await tx
        .select()
        .from(facilityRegulatoryProfiles)
        .where(eq(facilityRegulatoryProfiles.facilityId, values.facilityId))
        .limit(1)
        .for("update");
      const existing = existingRows[0];

      const licenceExpiryDate =
        values.licenceExpiryDate === undefined
          ? (existing?.licenceExpiryDate ?? null)
          : values.licenceExpiryDate;
      const licenceStatus =
        values.licenceStatus ??
        (licenceExpiryDate ? licenceStatusFor(licenceExpiryDate) : (existing?.licenceStatus ?? "pending"));

      const next = {
        kmpdcNumber: values.kmpdcNumber === undefined ? (existing?.kmpdcNumber ?? null) : values.kmpdcNumber,
        kmhflId: values.kmhflId === undefined ? (existing?.kmhflId ?? null) : values.kmhflId,
        kephLevel: values.kephLevel === undefined ? (existing?.kephLevel ?? null) : values.kephLevel,
        facilityCategory:
          values.facilityCategory === undefined ? (existing?.facilityCategory ?? null) : values.facilityCategory,
        ownership: values.ownership === undefined ? (existing?.ownership ?? null) : values.ownership,
        county: values.county,
        subCounty: values.subCounty,
        constituency:
          values.constituency === undefined ? (existing?.constituency ?? null) : values.constituency,
        ward: values.ward === undefined ? (existing?.ward ?? null) : values.ward,
        licenceNo: values.licenceNo === undefined ? (existing?.licenceNo ?? null) : values.licenceNo,
        licenceIssueDate:
          values.licenceIssueDate === undefined
            ? (existing?.licenceIssueDate ?? null)
            : values.licenceIssueDate,
        licenceExpiryDate,
        licenceStatus: licenceStatus as (typeof LICENCE_STATUSES)[number],
        indemnityProvider:
          values.indemnityProvider === undefined
            ? (existing?.indemnityProvider ?? null)
            : values.indemnityProvider,
        indemnityNo:
          values.indemnityNo === undefined ? (existing?.indemnityNo ?? null) : values.indemnityNo,
        indemnityExpiryDate:
          values.indemnityExpiryDate === undefined
            ? (existing?.indemnityExpiryDate ?? null)
            : values.indemnityExpiryDate,
        shaFacilityCode:
          values.shaFacilityCode === undefined
            ? (existing?.shaFacilityCode ?? null)
            : values.shaFacilityCode,
        shaEmpanelmentStatus:
          values.shaEmpanelmentStatus === undefined
            ? (existing?.shaEmpanelmentStatus ?? null)
            : values.shaEmpanelmentStatus,
        odpcRegistrationNo:
          values.odpcRegistrationNo === undefined
            ? (existing?.odpcRegistrationNo ?? null)
            : values.odpcRegistrationNo,
        odpcCategory:
          values.odpcCategory === undefined ? (existing?.odpcCategory ?? null) : values.odpcCategory,
        odpcExpiryDate:
          values.odpcExpiryDate === undefined
            ? (existing?.odpcExpiryDate ?? null)
            : values.odpcExpiryDate,
        kraPin:
          values.kraPin === undefined
            ? (existing?.kraPin ?? null)
            : values.kraPin
              ? normalizeKraPin(values.kraPin)
              : null,
        tccNo: values.tccNo === undefined ? (existing?.tccNo ?? null) : values.tccNo,
        tccExpiryDate:
          values.tccExpiryDate === undefined ? (existing?.tccExpiryDate ?? null) : values.tccExpiryDate,
        nssfEmployerCode:
          values.nssfEmployerCode === undefined
            ? (existing?.nssfEmployerCode ?? null)
            : values.nssfEmployerCode,
        shifEmployerCode:
          values.shifEmployerCode === undefined
            ? (existing?.shifEmployerCode ?? null)
            : values.shifEmployerCode,
        kemsaSupplierCode:
          values.kemsaSupplierCode === undefined
            ? (existing?.kemsaSupplierCode ?? null)
            : values.kemsaSupplierCode,
        updatedBy: userId,
        updatedAt: new Date(),
      };

      if (existing) {
        await tx
          .update(facilityRegulatoryProfiles)
          .set({ ...next, version: sql`${facilityRegulatoryProfiles.version} + 1` })
          .where(eq(facilityRegulatoryProfiles.facilityId, values.facilityId));
      } else {
        await tx.insert(facilityRegulatoryProfiles).values({
          facilityId: values.facilityId,
          ...next,
          createdBy: userId,
        });
      }

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.profile.upsert",
        entity: "facility_regulatory_profiles",
        entityId: values.facilityId,
        details: {
          before: existing
            ? {
                kraPin: existing.kraPin,
                kephLevel: existing.kephLevel,
                licenceStatus: existing.licenceStatus,
                licenceExpiryDate: existing.licenceExpiryDate,
              }
            : null,
          after: {
            kraPin: next.kraPin,
            kephLevel: next.kephLevel,
            licenceStatus: next.licenceStatus,
            licenceExpiryDate: next.licenceExpiryDate,
          },
        },
      });

      await publishEvent(tx, {
        type: "regulatory.profile.updated",
        facilityId: values.facilityId,
        licenceStatus: next.licenceStatus,
      });

      return {
        facilityId: values.facilityId,
        kraPin: next.kraPin,
        kephLevel: next.kephLevel,
        licenceStatus: next.licenceStatus,
        licenceExpiryDate: next.licenceExpiryDate,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Facility licence renewals (append-only)                             */
/* ------------------------------------------------------------------ */

export const updateFacilityLicenceSchema = z.object({
  ...baseSchema,
  licenceType: z
    .enum(["kmpdc_facility", "sha_empanelment", "odpc", "support_service", "other"])
    .default("kmpdc_facility"),
  licenceNo: z.string().trim().min(1).max(64),
  issueDate: isoDate.nullable().optional(),
  expiryDate: isoDate,
  status: licenceStatusSchema.optional(),
  supersedesId: z.uuid().nullable().optional(),
  documentRef: nullableText(500),
  notes: nullableText(1_000),
});

export type UpdateFacilityLicenceInput = z.input<typeof updateFacilityLicenceSchema>;
export interface FacilityLicenceResult {
  licenceId: string;
  licenceNo: string;
  status: string;
  expiryDate: string;
  supersedesId: string | null;
}

export async function updateFacilityLicence(
  input: UpdateFacilityLicenceInput,
  options: CommandOptions = {},
): Promise<FacilityLicenceResult> {
  const values = updateFacilityLicenceSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateFacilityLicence",
    async (tx) => {
      let supersedesId = values.supersedesId ?? null;

      if (supersedesId) {
        const previousRows = await tx
          .select()
          .from(facilityLicences)
          .where(
            and(
              eq(facilityLicences.id, supersedesId),
              eq(facilityLicences.facilityId, values.facilityId),
            ),
          )
          .limit(1)
          .for("update");
        const previous = previousRows[0];
        if (!previous) throw new Error("The licence being renewed was not found in this facility");
        if (values.issueDate && previous.expiryDate && values.issueDate < previous.expiryDate) {
          throw new Error(
            `The new licence cannot start before the previous licence expired on ${previous.expiryDate}`,
          );
        }
      } else {
        // Link a renewal to the latest licence of the same type automatically.
        const latestRows = await tx
          .select()
          .from(facilityLicences)
          .where(
            and(
              eq(facilityLicences.facilityId, values.facilityId),
              eq(facilityLicences.licenceType, values.licenceType),
            ),
          )
          .orderBy(desc(facilityLicences.expiryDate))
          .limit(1)
          .for("update");
        const latest = latestRows[0];
        if (latest) {
          if (values.issueDate && latest.expiryDate && values.issueDate < latest.expiryDate) {
            throw new Error(
              `The new licence cannot start before the previous licence expired on ${latest.expiryDate}`,
            );
          }
          supersedesId = latest.id;
        }
      }

      if (values.issueDate && values.expiryDate <= values.issueDate) {
        throw new Error("The expiry date must be after the issue date");
      }

      const status = values.status ?? licenceStatusFor(values.expiryDate);

      const inserted = await tx
        .insert(facilityLicences)
        .values({
          facilityId: values.facilityId,
          licenceType: values.licenceType,
          licenceNo: values.licenceNo,
          issueDate: values.issueDate ?? null,
          expiryDate: values.expiryDate,
          status: status as (typeof LICENCE_STATUSES)[number],
          supersedesId,
          documentRef: values.documentRef ?? null,
          notes: values.notes ?? null,
          createdBy: userId,
        })
        .returning({ id: facilityLicences.id });
      const licenceId = inserted[0]!.id;

      // The profile carries the current snapshot for downstream controls.
      if (values.licenceType === "kmpdc_facility") {
        await tx
          .update(facilityRegulatoryProfiles)
          .set({
            licenceNo: values.licenceNo,
            licenceIssueDate: values.issueDate ?? null,
            licenceExpiryDate: values.expiryDate,
            licenceStatus: status as (typeof LICENCE_STATUSES)[number],
            updatedBy: userId,
            updatedAt: new Date(),
            version: sql`${facilityRegulatoryProfiles.version} + 1`,
          })
          .where(eq(facilityRegulatoryProfiles.facilityId, values.facilityId));
      }

      await recordAudit(tx, {
        ...auditMeta(values),
        action: supersedesId ? "regulatory.licence.renew" : "regulatory.licence.create",
        entity: "facility_licences",
        entityId: licenceId,
        details: {
          licenceType: values.licenceType,
          licenceNo: values.licenceNo,
          expiryDate: values.expiryDate,
          status,
          supersedesId,
        },
      });

      await publishEvent(tx, {
        type: "regulatory.licence.recorded",
        facilityId: values.facilityId,
        licenceId,
        licenceType: values.licenceType,
        status,
      });

      return {
        licenceId,
        licenceNo: values.licenceNo,
        status,
        expiryDate: values.expiryDate,
        supersedesId,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Practitioner registrations                                          */
/* ------------------------------------------------------------------ */

export const upsertPractitionerRegistrationSchema = z.object({
  ...baseSchema,
  staffProfileId: z.uuid(),
  regulator: regulatorSchema,
  profession: z.string().trim().min(1).max(100),
  registrationNo: z.string().trim().min(1).max(64),
  annualLicenceNo: nullableText(64),
  licenceIssueDate: isoDate.nullable().optional(),
  licenceExpiryDate: isoDate.nullable().optional(),
  licenceStatus: licenceStatusSchema.optional(),
  cpdPoints: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Use a number with at most two decimals")
    .nullable()
    .optional(),
  cpdCycle: nullableText(32),
  cpdStatus: nullableText(32),
  specialistRecognition: nullableText(200),
  verifiedAt: z.string().datetime().nullable().optional(),
  verifiedBy: nullableText(128),
  active: z.boolean().optional(),
});

export type UpsertPractitionerRegistrationInput = z.input<
  typeof upsertPractitionerRegistrationSchema
>;
export interface PractitionerRegistrationResult {
  registrationId: string;
  regulator: string;
  registrationNo: string;
  licenceStatus: string;
  licenceExpiryDate: string | null;
}

export async function upsertPractitionerRegistration(
  input: UpsertPractitionerRegistrationInput,
  options: CommandOptions = {},
): Promise<PractitionerRegistrationResult> {
  const values = upsertPractitionerRegistrationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertPractitionerRegistration",
    async (tx) => {
      const staffRows = await tx
        .select({ userId: staffProfiles.userId })
        .from(staffProfiles)
        .innerJoin(staffRoleScopes, eq(staffRoleScopes.userId, staffProfiles.userId))
        .where(
          and(
            eq(staffProfiles.id, values.staffProfileId),
            eq(staffRoleScopes.facilityId, values.facilityId),
          ),
        )
        .limit(1);
      if (!staffRows[0]) throw new Error("That staff profile does not work in this facility");

      const existingRows = await tx
        .select()
        .from(practitionerRegistrations)
        .where(
          and(
            eq(practitionerRegistrations.facilityId, values.facilityId),
            eq(practitionerRegistrations.staffProfileId, values.staffProfileId),
            eq(practitionerRegistrations.regulator, values.regulator),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];

      const licenceExpiryDate =
        values.licenceExpiryDate === undefined
          ? (existing?.licenceExpiryDate ?? null)
          : values.licenceExpiryDate;
      const licenceStatus =
        values.licenceStatus ??
        (licenceExpiryDate ? licenceStatusFor(licenceExpiryDate) : (existing?.licenceStatus ?? "pending"));

      if (values.verifiedAt && !values.verifiedBy && !existing?.verifiedBy) {
        throw new Error("Name the person who verified the licence before recording a verification time");
      }

      const next = {
        regulator: values.regulator,
        profession: values.profession,
        registrationNo: values.registrationNo,
        annualLicenceNo:
          values.annualLicenceNo === undefined
            ? (existing?.annualLicenceNo ?? null)
            : values.annualLicenceNo,
        licenceIssueDate:
          values.licenceIssueDate === undefined
            ? (existing?.licenceIssueDate ?? null)
            : values.licenceIssueDate,
        licenceExpiryDate,
        licenceStatus: licenceStatus as (typeof LICENCE_STATUSES)[number],
        cpdPoints:
          values.cpdPoints === undefined ? (existing?.cpdPoints ?? null) : values.cpdPoints,
        cpdCycle: values.cpdCycle === undefined ? (existing?.cpdCycle ?? null) : values.cpdCycle,
        cpdStatus: values.cpdStatus === undefined ? (existing?.cpdStatus ?? null) : values.cpdStatus,
        specialistRecognition:
          values.specialistRecognition === undefined
            ? (existing?.specialistRecognition ?? null)
            : values.specialistRecognition,
        verifiedAt: values.verifiedAt ? new Date(values.verifiedAt) : (existing?.verifiedAt ?? null),
        verifiedBy: values.verifiedBy ?? existing?.verifiedBy ?? null,
        active: values.active ?? existing?.active ?? true,
        updatedAt: new Date(),
      };

      let registrationId: string;
      if (existing) {
        registrationId = existing.id;
        await tx
          .update(practitionerRegistrations)
          .set({ ...next, version: sql`${practitionerRegistrations.version} + 1` })
          .where(eq(practitionerRegistrations.id, existing.id));
      } else {
        const inserted = await tx
          .insert(practitionerRegistrations)
          .values({
            facilityId: values.facilityId,
            staffProfileId: values.staffProfileId,
            ...next,
            createdBy: userId,
          })
          .returning({ id: practitionerRegistrations.id });
        registrationId = inserted[0]!.id;
      }

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.practitioner.upsert",
        entity: "practitioner_registrations",
        entityId: registrationId,
        details: {
          regulator: next.regulator,
          registrationNo: next.registrationNo,
          licenceStatus: next.licenceStatus,
          licenceExpiryDate: next.licenceExpiryDate,
          created: !existing,
        },
      });

      return {
        registrationId,
        regulator: next.regulator,
        registrationNo: next.registrationNo,
        licenceStatus: next.licenceStatus,
        licenceExpiryDate: next.licenceExpiryDate,
      };
    },
    options,
  );
}

export const verifyPractitionerLicenceSchema = z.object({
  ...baseSchema,
  registrationId: z.uuid(),
  verifiedAt: z.string().datetime().optional(),
});

export type VerifyPractitionerLicenceInput = z.input<typeof verifyPractitionerLicenceSchema>;
export interface VerifyPractitionerLicenceResult {
  registrationId: string;
  licenceStatus: string;
  verifiedAt: string;
  verifiedBy: string;
}

const VERIFIER_ROLES = ["admin", "regulatory_officer"] as const;

async function assertCanVerify(tx: CommandTransaction, facilityId: string, userId: string) {
  const rows = await tx
    .select({ role: staffRoleScopes.role })
    .from(staffRoleScopes)
    .where(
      and(eq(staffRoleScopes.userId, userId), eq(staffRoleScopes.facilityId, facilityId)),
    );
  if (!rows.some((row) => (VERIFIER_ROLES as readonly string[]).includes(row.role))) {
    throw new ForbiddenError(
      "Only an administrator or regulatory officer can verify a practitioner licence",
    );
  }
}

export async function verifyPractitionerLicence(
  input: VerifyPractitionerLicenceInput,
  options: CommandOptions = {},
): Promise<VerifyPractitionerLicenceResult> {
  const values = verifyPractitionerLicenceSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "verifyPractitionerLicence",
    async (tx) => {
      await assertCanVerify(tx, values.facilityId, userId);

      const rows = await tx
        .select()
        .from(practitionerRegistrations)
        .where(
          and(
            eq(practitionerRegistrations.id, values.registrationId),
            eq(practitionerRegistrations.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const registration = rows[0];
      if (!registration) throw new Error("Practitioner registration not found in this facility");

      const verifiedAt = values.verifiedAt ? new Date(values.verifiedAt) : new Date();
      const licenceStatus = registration.licenceExpiryDate
        ? licenceStatusFor(registration.licenceExpiryDate)
        : registration.licenceStatus;

      await tx
        .update(practitionerRegistrations)
        .set({
          verifiedAt,
          verifiedBy: userId,
          licenceStatus: licenceStatus as (typeof LICENCE_STATUSES)[number],
          updatedAt: new Date(),
          version: sql`${practitionerRegistrations.version} + 1`,
        })
        .where(eq(practitionerRegistrations.id, registration.id));

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.practitioner.verify",
        entity: "practitioner_registrations",
        entityId: registration.id,
        details: {
          verifiedBy: userId,
          verifiedAt: verifiedAt.toISOString(),
          licenceStatus,
        },
      });

      return {
        registrationId: registration.id,
        licenceStatus,
        verifiedAt: verifiedAt.toISOString(),
        verifiedBy: userId,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Support-service licences                                            */
/* ------------------------------------------------------------------ */

export const upsertSupportServiceLicenceSchema = z.object({
  ...baseSchema,
  licenceId: z.uuid().nullable().optional(),
  serviceType: supportServiceTypeSchema,
  licenceNo: z.string().trim().min(1).max(64),
  issuingAuthority: z.string().trim().min(1).max(200),
  issueDate: isoDate.nullable().optional(),
  expiryDate: isoDate,
  status: licenceStatusSchema.optional(),
  conditions: nullableText(2_000),
  active: z.boolean().optional(),
});

export type UpsertSupportServiceLicenceInput = z.input<
  typeof upsertSupportServiceLicenceSchema
>;
export interface SupportServiceLicenceResult {
  licenceId: string;
  serviceType: string;
  licenceNo: string;
  status: string;
  expiryDate: string;
}

export async function upsertSupportServiceLicence(
  input: UpsertSupportServiceLicenceInput,
  options: CommandOptions = {},
): Promise<SupportServiceLicenceResult> {
  const values = upsertSupportServiceLicenceSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertSupportServiceLicence",
    async (tx) => {
      const status =
        values.status ??
        (values.expiryDate ? licenceStatusFor(values.expiryDate) : "pending");

      if (values.licenceId) {
        const rows = await tx
          .select()
          .from(supportServiceLicences)
          .where(
            and(
              eq(supportServiceLicences.id, values.licenceId),
              eq(supportServiceLicences.facilityId, values.facilityId),
            ),
          )
          .limit(1)
          .for("update");
        const existing = rows[0];
        if (!existing) throw new Error("Support-service licence not found in this facility");

        await tx
          .update(supportServiceLicences)
          .set({
            serviceType: values.serviceType,
            licenceNo: values.licenceNo,
            issuingAuthority: values.issuingAuthority,
            issueDate: values.issueDate ?? existing.issueDate,
            expiryDate: values.expiryDate,
            status: status as (typeof LICENCE_STATUSES)[number],
            conditions: values.conditions === undefined ? existing.conditions : values.conditions,
            active: values.active ?? existing.active,
            updatedAt: new Date(),
            version: sql`${supportServiceLicences.version} + 1`,
          })
          .where(eq(supportServiceLicences.id, existing.id));

        await recordAudit(tx, {
          ...auditMeta(values),
          action: "regulatory.support_service.update",
          entity: "support_service_licences",
          entityId: existing.id,
          details: { before: existing.status, after: status, licenceNo: values.licenceNo },
        });

        return {
          licenceId: existing.id,
          serviceType: values.serviceType,
          licenceNo: values.licenceNo,
          status,
          expiryDate: values.expiryDate,
        };
      }

      const inserted = await tx
        .insert(supportServiceLicences)
        .values({
          facilityId: values.facilityId,
          serviceType: values.serviceType,
          licenceNo: values.licenceNo,
          issuingAuthority: values.issuingAuthority,
          issueDate: values.issueDate ?? null,
          expiryDate: values.expiryDate,
          status: status as (typeof LICENCE_STATUSES)[number],
          conditions: values.conditions ?? null,
          active: values.active ?? true,
          createdBy: userId,
        })
        .returning({ id: supportServiceLicences.id });

      const licenceId = inserted[0]!.id;
      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.support_service.create",
        entity: "support_service_licences",
        entityId: licenceId,
        details: { serviceType: values.serviceType, licenceNo: values.licenceNo, status },
      });

      return {
        licenceId,
        serviceType: values.serviceType,
        licenceNo: values.licenceNo,
        status,
        expiryDate: values.expiryDate,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Facility identifiers                                                */
/* ------------------------------------------------------------------ */

export const upsertFacilityIdentifierSchema = z.object({
  ...baseSchema,
  identifierType: z.string().trim().min(1).max(64),
  value: z.string().trim().min(1).max(200),
  issuingAuthority: nullableText(200),
  validFrom: isoDate.nullable().optional(),
  validTo: isoDate.nullable().optional(),
  status: nullableText(32),
});

export type UpsertFacilityIdentifierInput = z.input<typeof upsertFacilityIdentifierSchema>;
export interface FacilityIdentifierResult {
  identifierId: string;
  identifierType: string;
  value: string;
}

export async function upsertFacilityIdentifier(
  input: UpsertFacilityIdentifierInput,
  options: CommandOptions = {},
): Promise<FacilityIdentifierResult> {
  const values = upsertFacilityIdentifierSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertFacilityIdentifier",
    async (tx) => {
      const existingRows = await tx
        .select()
        .from(facilityIdentifiers)
        .where(
          and(
            eq(facilityIdentifiers.facilityId, values.facilityId),
            eq(facilityIdentifiers.identifierType, values.identifierType),
            eq(facilityIdentifiers.value, values.value),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];

      if (existing) {
        await tx
          .update(facilityIdentifiers)
          .set({
            issuingAuthority:
              values.issuingAuthority === undefined
                ? existing.issuingAuthority
                : values.issuingAuthority,
            validFrom: values.validFrom === undefined ? existing.validFrom : values.validFrom,
            validTo: values.validTo === undefined ? existing.validTo : values.validTo,
            status: values.status === undefined ? existing.status : values.status,
            updatedAt: new Date(),
            version: sql`${facilityIdentifiers.version} + 1`,
          })
          .where(eq(facilityIdentifiers.id, existing.id));
      } else {
        const inserted = await tx
          .insert(facilityIdentifiers)
          .values({
            facilityId: values.facilityId,
            identifierType: values.identifierType,
            value: values.value,
            issuingAuthority: values.issuingAuthority ?? null,
            validFrom: values.validFrom ?? null,
            validTo: values.validTo ?? null,
            status: values.status ?? null,
            createdBy: userId,
          })
          .returning({ id: facilityIdentifiers.id });
        await recordAudit(tx, {
          ...auditMeta(values),
          action: "regulatory.identifier.create",
          entity: "facility_identifiers",
          entityId: inserted[0]!.id,
          details: { identifierType: values.identifierType, value: values.value },
        });
        return {
          identifierId: inserted[0]!.id,
          identifierType: values.identifierType,
          value: values.value,
        };
      }

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.identifier.update",
        entity: "facility_identifiers",
        entityId: existing.id,
        details: { identifierType: values.identifierType, value: values.value },
      });

      return {
        identifierId: existing.id,
        identifierType: values.identifierType,
        value: values.value,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Licence alert rules                                                 */
/* ------------------------------------------------------------------ */

export const createLicenceAlertRuleSchema = z.object({
  ...baseSchema,
  subjectType: z.enum(["facility", "practitioner", "support_service", "odpc", "sha"]),
  subjectId: z.uuid().nullable().optional(),
  warnDays: z.array(z.number().int().positive()).min(1, "Add at least one warning window"),
  blockDays: z.array(z.number().int().min(0)).min(1, "Add at least one blocking window"),
  notifyRoles: z.array(roleSchema).min(1, "Choose at least one role to notify"),
  enabled: z.boolean().optional(),
});

export type CreateLicenceAlertRuleInput = z.input<typeof createLicenceAlertRuleSchema>;
export interface LicenceAlertRuleResult {
  ruleId: string;
  subjectType: string;
  warnDays: number[];
  blockDays: number[];
  notifyRoles: string[];
}

export async function createLicenceAlertRule(
  input: CreateLicenceAlertRuleInput,
  options: CommandOptions = {},
): Promise<LicenceAlertRuleResult> {
  const values = createLicenceAlertRuleSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createLicenceAlertRule",
    async (tx) => {
      const inserted = await tx
        .insert(licenceAlertRules)
        .values({
          facilityId: values.facilityId,
          subjectType: values.subjectType,
          subjectId: values.subjectId ?? null,
          warnDays: values.warnDays,
          blockDays: values.blockDays,
          notifyRoles: values.notifyRoles,
          enabled: values.enabled ?? true,
          createdBy: userId,
        })
        .returning({ id: licenceAlertRules.id });

      const ruleId = inserted[0]!.id;
      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.alert_rule.create",
        entity: "licence_alert_rules",
        entityId: ruleId,
        details: {
          subjectType: values.subjectType,
          warnDays: values.warnDays,
          blockDays: values.blockDays,
          notifyRoles: values.notifyRoles,
        },
      });

      return {
        ruleId,
        subjectType: values.subjectType,
        warnDays: values.warnDays,
        blockDays: values.blockDays,
        notifyRoles: values.notifyRoles,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Facility settings (effective-dated, validated)                      */
/* ------------------------------------------------------------------ */

export const upsertFacilitySettingSchema = z.object({
  ...baseSchema,
  domain: settingDomainSchema,
  key: z.string().trim().min(1).max(64),
  value: z.unknown().optional(),
  effectiveFrom: isoDate.optional(),
});

export type UpsertFacilitySettingInput = z.input<typeof upsertFacilitySettingSchema>;
export interface FacilitySettingResult {
  settingId: string;
  domain: string;
  key: string;
  displayValue: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  missing: boolean;
}

export async function upsertFacilitySetting(
  input: UpsertFacilitySettingInput,
  options: CommandOptions = {},
): Promise<FacilitySettingResult> {
  const values = upsertFacilitySettingSchema.parse(input);
  const userId = actorId(values);

  const definition = settingDefinition(values.domain, values.key);
  if (!definition) {
    throw new Error(
      `Unknown setting ${values.domain}.${values.key}. Add it to REGULATORY_SETTINGS before it can be edited.`,
    );
  }

  const validation = validateSettingValue(definition, values.value);
  if (!validation.ok) {
    throw new Error(`${values.domain}.${values.key}: ${validation.error}`);
  }

  const effectiveFrom = values.effectiveFrom ?? todayIso();

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertFacilitySetting",
    async (tx) => {
      const currentRows = await tx
        .select()
        .from(facilitySettings)
        .where(
          and(
            eq(facilitySettings.facilityId, values.facilityId),
            eq(facilitySettings.domain, values.domain),
            eq(facilitySettings.key, values.key),
            lte(facilitySettings.effectiveFrom, effectiveFrom),
            or(isNull(facilitySettings.effectiveTo), gte(facilitySettings.effectiveTo, effectiveFrom)),
          ),
        )
        .orderBy(desc(facilitySettings.effectiveFrom))
        .limit(1)
        .for("update");
      const current = currentRows[0];

      if (current && effectiveFrom < current.effectiveFrom) {
        throw new Error(
          `This setting is already effective from ${current.effectiveFrom}; choose a later effective date`,
        );
      }

      const columns = validation.columns;
      const common = {
        dataType: definition.dataType,
        allowedValues: definition.allowedValues ?? null,
        minValue: definition.min !== undefined ? String(definition.min) : null,
        maxValue: definition.max !== undefined ? String(definition.max) : null,
        regex: definition.pattern ?? null,
        isRequired: definition.required,
        isSecret: definition.secret ?? false,
        valueText: columns.valueText,
        valueNumeric: columns.valueNumeric === null ? null : String(columns.valueNumeric),
        valueJson: columns.valueJson,
        updatedBy: userId,
        updatedAt: new Date(),
      };

      let settingId: string;
      let effectiveTo: string | null = null;

      if (current && current.effectiveFrom === effectiveFrom) {
        settingId = current.id;
        await tx
          .update(facilitySettings)
          .set({ ...common, version: sql`${facilitySettings.version} + 1` })
          .where(eq(facilitySettings.id, current.id));
      } else {
        if (current) {
          effectiveTo = addDays(effectiveFrom, -1);
          await tx
            .update(facilitySettings)
            .set({ effectiveTo, updatedAt: new Date(), version: sql`${facilitySettings.version} + 1` })
            .where(eq(facilitySettings.id, current.id));
        }
        const inserted = await tx
          .insert(facilitySettings)
          .values({
            facilityId: values.facilityId,
            domain: values.domain,
            key: values.key,
            ...common,
            effectiveFrom,
            effectiveTo: null,
            createdBy: userId,
          })
          .returning({ id: facilitySettings.id });
        settingId = inserted[0]!.id;
      }

      const displayValue = columns.valueText ?? (columns.valueNumeric === null ? "" : String(columns.valueNumeric));

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.setting.upsert",
        entity: "facility_settings",
        entityId: settingId,
        details: {
          domain: values.domain,
          key: values.key,
          before: current
            ? {
                valueText: current.valueText,
                valueNumeric: current.valueNumeric,
                valueJson: current.valueJson,
                effectiveFrom: current.effectiveFrom,
              }
            : null,
          after: {
            valueText: columns.valueText,
            valueNumeric: columns.valueNumeric,
            valueJson: columns.valueJson,
            effectiveFrom,
          },
        },
      });

      await publishEvent(tx, {
        type: "regulatory.setting.changed",
        facilityId: values.facilityId,
        domain: values.domain,
        key: values.key,
      });

      return {
        settingId,
        domain: values.domain,
        key: values.key,
        displayValue,
        effectiveFrom,
        effectiveTo,
        missing: displayValue === "" && definition.required,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Statutory rates                                                     */
/* ------------------------------------------------------------------ */

export const upsertStatutoryRateSchema = z.object({
  ...baseSchema,
  rateId: z.uuid().nullable().optional(),
  rateType: z.enum(["paye_band", "nssf_tier", "shif", "housing_levy", "other"]),
  bandOrder: z.number().int().min(0),
  lowerBound: money,
  upperBound: money.nullable().optional(),
  ratePercent: z.number().min(0, "The rate must be between 0 and 100").max(100, "The rate must be between 0 and 100"),
  fixedAmount: money.nullable().optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  legalReference: nullableText(500),
  active: z.boolean().optional(),
});

export type UpsertStatutoryRateInput = z.input<typeof upsertStatutoryRateSchema>;
export interface StatutoryRateResult {
  rateId: string;
  rateType: string;
  bandOrder: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function upsertStatutoryRate(
  input: UpsertStatutoryRateInput,
  options: CommandOptions = {},
): Promise<StatutoryRateResult> {
  const values = upsertStatutoryRateSchema.parse(input);
  const userId = actorId(values);

  if (values.upperBound !== null && values.upperBound !== undefined) {
    if (Number(values.lowerBound) > Number(values.upperBound)) {
      throw new Error("The lower bound must not be greater than the upper bound");
    }
  }
  if (values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
    throw new Error("The effective end date cannot be before the effective start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertStatutoryRate",
    async (tx) => {
      if (values.rateId) {
        const rows = await tx
          .select()
          .from(statutoryRates)
          .where(
            and(
              eq(statutoryRates.id, values.rateId),
              eq(statutoryRates.facilityId, values.facilityId),
            ),
          )
          .limit(1)
          .for("update");
        if (!rows[0]) throw new Error("Statutory rate not found in this facility");
        await tx
          .update(statutoryRates)
          .set({
            effectiveTo: addDays(values.effectiveFrom, -1),
            active: false,
            updatedAt: new Date(),
            version: sql`${statutoryRates.version} + 1`,
          })
          .where(eq(statutoryRates.id, rows[0].id));
      }

      const newTo = values.effectiveTo ?? "9999-12-31";
      const overlapping = await tx
        .select({ id: statutoryRates.id })
        .from(statutoryRates)
        .where(
          and(
            eq(statutoryRates.facilityId, values.facilityId),
            eq(statutoryRates.rateType, values.rateType),
            eq(statutoryRates.bandOrder, values.bandOrder),
            eq(statutoryRates.active, true),
            lte(statutoryRates.effectiveFrom, newTo),
            or(
              isNull(statutoryRates.effectiveTo),
              gte(statutoryRates.effectiveTo, values.effectiveFrom),
            ),
            values.rateId ? sql`${statutoryRates.id} <> ${values.rateId}::uuid` : sql`true`,
          ),
        )
        .limit(1);
      if (overlapping[0]) {
        throw new Error(
          `A ${values.rateType} band ${values.bandOrder} rate already covers that period`,
        );
      }

      const inserted = await tx
        .insert(statutoryRates)
        .values({
          facilityId: values.facilityId,
          rateType: values.rateType,
          bandOrder: values.bandOrder,
          lowerBound: values.lowerBound,
          upperBound: values.upperBound ?? null,
          ratePercent: String(values.ratePercent),
          fixedAmount: values.fixedAmount ?? null,
          effectiveFrom: values.effectiveFrom,
          effectiveTo: values.effectiveTo ?? null,
          legalReference: values.legalReference ?? null,
          active: values.active ?? true,
          createdBy: userId,
        })
        .returning({ id: statutoryRates.id });

      const rateId = inserted[0]!.id;
      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.statutory_rate.upsert",
        entity: "statutory_rates",
        entityId: rateId,
        details: {
          rateType: values.rateType,
          bandOrder: values.bandOrder,
          ratePercent: values.ratePercent,
          effectiveFrom: values.effectiveFrom,
          effectiveTo: values.effectiveTo ?? null,
        },
      });

      return {
        rateId,
        rateType: values.rateType,
        bandOrder: values.bandOrder,
        effectiveFrom: values.effectiveFrom,
        effectiveTo: values.effectiveTo ?? null,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Statutory fee schedules                                             */
/* ------------------------------------------------------------------ */

export const upsertStatutoryFeeScheduleSchema = z.object({
  ...baseSchema,
  feeId: z.uuid().nullable().optional(),
  authority: z.enum(["kmpdc", "odpc", "ppb", "kmlttb", "rpb", "nssf", "kra", "other"]),
  category: z.string().trim().min(1).max(200),
  amount: money.refine((value) => Number(value) >= 0, "The amount cannot be negative"),
  currency: z.string().trim().length(3).default("KES"),
  renewalMonth: z.number().int().min(1).max(12).nullable().optional(),
  renewalDay: z.number().int().min(1).max(31).nullable().optional(),
  penaltyNote: nullableText(1_000),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  sourceUrl: z.string().trim().url("Add the regulator page this fee came from"),
  active: z.boolean().optional(),
});

export type UpsertStatutoryFeeScheduleInput = z.input<typeof upsertStatutoryFeeScheduleSchema>;
export interface StatutoryFeeScheduleResult {
  feeId: string;
  authority: string;
  category: string;
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function upsertStatutoryFeeSchedule(
  input: UpsertStatutoryFeeScheduleInput,
  options: CommandOptions = {},
): Promise<StatutoryFeeScheduleResult> {
  const values = upsertStatutoryFeeScheduleSchema.parse(input);
  const userId = actorId(values);

  if (values.effectiveTo && values.effectiveTo < values.effectiveFrom) {
    throw new Error("The effective end date cannot be before the effective start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertStatutoryFeeSchedule",
    async (tx) => {
      if (values.feeId) {
        const rows = await tx
          .select()
          .from(statutoryFeeSchedules)
          .where(
            and(
              eq(statutoryFeeSchedules.id, values.feeId),
              eq(statutoryFeeSchedules.facilityId, values.facilityId),
            ),
          )
          .limit(1)
          .for("update");
        if (!rows[0]) throw new Error("Statutory fee not found in this facility");
        await tx
          .update(statutoryFeeSchedules)
          .set({
            effectiveTo: addDays(values.effectiveFrom, -1),
            active: false,
            updatedAt: new Date(),
            version: sql`${statutoryFeeSchedules.version} + 1`,
          })
          .where(eq(statutoryFeeSchedules.id, rows[0].id));
      }

      const newTo = values.effectiveTo ?? "9999-12-31";
      const overlapping = await tx
        .select({ id: statutoryFeeSchedules.id })
        .from(statutoryFeeSchedules)
        .where(
          and(
            eq(statutoryFeeSchedules.facilityId, values.facilityId),
            eq(statutoryFeeSchedules.authority, values.authority),
            eq(statutoryFeeSchedules.category, values.category),
            eq(statutoryFeeSchedules.active, true),
            lte(statutoryFeeSchedules.effectiveFrom, newTo),
            or(
              isNull(statutoryFeeSchedules.effectiveTo),
              gte(statutoryFeeSchedules.effectiveTo, values.effectiveFrom),
            ),
            values.feeId ? sql`${statutoryFeeSchedules.id} <> ${values.feeId}::uuid` : sql`true`,
          ),
        )
        .limit(1);
      if (overlapping[0]) {
        throw new Error(
          `A ${values.authority} fee for ${values.category} already covers that period`,
        );
      }

      const inserted = await tx
        .insert(statutoryFeeSchedules)
        .values({
          facilityId: values.facilityId,
          authority: values.authority,
          category: values.category,
          amount: values.amount,
          currency: values.currency,
          renewalMonth: values.renewalMonth ?? null,
          renewalDay: values.renewalDay ?? null,
          penaltyNote: values.penaltyNote ?? null,
          effectiveFrom: values.effectiveFrom,
          effectiveTo: values.effectiveTo ?? null,
          sourceUrl: values.sourceUrl,
          active: values.active ?? true,
          createdBy: userId,
        })
        .returning({ id: statutoryFeeSchedules.id });

      const feeId = inserted[0]!.id;
      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.statutory_fee.upsert",
        entity: "statutory_fee_schedules",
        entityId: feeId,
        details: {
          authority: values.authority,
          category: values.category,
          amount: values.amount,
          effectiveFrom: values.effectiveFrom,
        },
      });

      return {
        feeId,
        authority: values.authority,
        category: values.category,
        amount: values.amount,
        effectiveFrom: values.effectiveFrom,
        effectiveTo: values.effectiveTo ?? null,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* SHA adjudication codes                                              */
/* ------------------------------------------------------------------ */

export const upsertShaAdjudicationCodeSchema = z.object({
  ...baseSchema,
  codeId: z.uuid().nullable().optional(),
  code: z.string().trim().min(1).max(32),
  description: z.string().trim().min(1).max(500),
  category: z.enum(["approved", "reduced", "rejected", "info"]),
  retryable: z.boolean().optional(),
  actionHint: nullableText(1_000),
  active: z.boolean().optional(),
});

export type UpsertShaAdjudicationCodeInput = z.input<typeof upsertShaAdjudicationCodeSchema>;
export interface ShaAdjudicationCodeResult {
  codeId: string;
  code: string;
  category: string;
  active: boolean;
}

export async function upsertShaAdjudicationCode(
  input: UpsertShaAdjudicationCodeInput,
  options: CommandOptions = {},
): Promise<ShaAdjudicationCodeResult> {
  const values = upsertShaAdjudicationCodeSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertShaAdjudicationCode",
    async (tx) => {
      const existingRows = await tx
        .select()
        .from(shaAdjudicationCodes)
        .where(
          and(
            eq(shaAdjudicationCodes.facilityId, values.facilityId),
            eq(shaAdjudicationCodes.code, values.code),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];

      const active = values.active ?? existing?.active ?? true;

      if (existing) {
        await tx
          .update(shaAdjudicationCodes)
          .set({
            description: values.description,
            category: values.category,
            retryable: values.retryable ?? existing.retryable,
            actionHint: values.actionHint === undefined ? existing.actionHint : values.actionHint,
            active,
            updatedAt: new Date(),
            version: sql`${shaAdjudicationCodes.version} + 1`,
          })
          .where(eq(shaAdjudicationCodes.id, existing.id));

        await recordAudit(tx, {
          ...auditMeta(values),
          action: "regulatory.sha_code.upsert",
          entity: "sha_adjudication_codes",
          entityId: existing.id,
          details: { code: values.code, category: values.category, active },
        });

        return { codeId: existing.id, code: values.code, category: values.category, active };
      }

      const inserted = await tx
        .insert(shaAdjudicationCodes)
        .values({
          facilityId: values.facilityId,
          code: values.code,
          description: values.description,
          category: values.category,
          retryable: values.retryable ?? false,
          actionHint: values.actionHint ?? null,
          active,
          createdBy: userId,
        })
        .returning({ id: shaAdjudicationCodes.id });

      const codeId = inserted[0]!.id;
      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.sha_code.create",
        entity: "sha_adjudication_codes",
        entityId: codeId,
        details: { code: values.code, category: values.category },
      });

      return { codeId, code: values.code, category: values.category, active };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Integration settings                                                */
/* ------------------------------------------------------------------ */

const RAW_SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/,
  /bearer\s+[A-Za-z0-9._-]{10,}/i,
  /api[_-]?key\s*[:=]\s*\S{8,}/i,
  /[A-Fa-f0-9]{40,}/,
];

function assertNoRawSecret(field: string, value: string | null | undefined) {
  if (!value) return;
  if (RAW_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(
      `${field} looks like a raw secret. Store the secret in the environment and put its variable name in credential_ref.`,
    );
  }
}

export const upsertIntegrationSettingSchema = z.object({
  ...baseSchema,
  integrationId: z.uuid().nullable().optional(),
  integration: z.enum(["etims", "khis", "sha_portal", "sms", "payments"]),
  environment: z.enum(["sandbox", "production"]),
  baseUrl: z.string().trim().url().nullable().optional(),
  specVersion: nullableText(64),
  mode: z.enum(["oscu", "vscu", "api", "manual"]).nullable().optional(),
  credentialRef: z
    .string()
    .trim()
    .min(1, "credential_ref is required")
    .max(200)
    .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/, "credential_ref must name an environment variable or secret"),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  backoffSeconds: z.array(z.number().int().min(0)).optional(),
  enabled: z.boolean().optional(),
});

export type UpsertIntegrationSettingInput = z.input<typeof upsertIntegrationSettingSchema>;
export interface IntegrationSettingResult {
  integrationId: string;
  integration: string;
  environment: string;
  enabled: boolean;
}

export async function upsertIntegrationSetting(
  input: UpsertIntegrationSettingInput,
  options: CommandOptions = {},
): Promise<IntegrationSettingResult> {
  const values = upsertIntegrationSettingSchema.parse(input);
  const userId = actorId(values);

  assertNoRawSecret("base_url", values.baseUrl ?? null);
  assertNoRawSecret("credential_ref", values.credentialRef);
  assertNoRawSecret("mode", values.mode ?? null);
  assertNoRawSecret("spec_version", values.specVersion ?? null);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertIntegrationSetting",
    async (tx) => {
      const existingRows = await tx
        .select()
        .from(integrationSettings)
        .where(
          and(
            eq(integrationSettings.facilityId, values.facilityId),
            eq(integrationSettings.integration, values.integration),
            eq(integrationSettings.environment, values.environment),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];

      const next = {
        baseUrl: values.baseUrl === undefined ? (existing?.baseUrl ?? null) : values.baseUrl,
        specVersion:
          values.specVersion === undefined ? (existing?.specVersion ?? null) : values.specVersion,
        mode: values.mode === undefined ? (existing?.mode ?? null) : values.mode,
        credentialRef: values.credentialRef,
        timeoutMs: values.timeoutMs ?? existing?.timeoutMs ?? 30_000,
        maxAttempts: values.maxAttempts ?? existing?.maxAttempts ?? 5,
        backoffSeconds: values.backoffSeconds ?? existing?.backoffSeconds ?? [30, 120, 600, 1800, 3600],
        enabled: values.enabled ?? existing?.enabled ?? false,
        updatedAt: new Date(),
      };

      let integrationId: string;
      if (existing) {
        integrationId = existing.id;
        await tx
          .update(integrationSettings)
          .set({ ...next, version: sql`${integrationSettings.version} + 1` })
          .where(eq(integrationSettings.id, existing.id));
      } else {
        const inserted = await tx
          .insert(integrationSettings)
          .values({
            facilityId: values.facilityId,
            integration: values.integration,
            environment: values.environment,
            ...next,
            createdBy: userId,
          })
          .returning({ id: integrationSettings.id });
        integrationId = inserted[0]!.id;
      }

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.integration.upsert",
        entity: "integration_settings",
        entityId: integrationId,
        details: {
          integration: values.integration,
          environment: values.environment,
          credentialRef: values.credentialRef,
          enabled: next.enabled,
          created: !existing,
        },
      });

      return {
        integrationId,
        integration: values.integration,
        environment: values.environment,
        enabled: next.enabled,
      };
    },
    options,
  );
}

export const verifyIntegrationConnectionSchema = z.object({
  ...baseSchema,
  integration: z.enum(["etims", "khis", "sha_portal", "sms", "payments"]),
  environment: z.enum(["sandbox", "production"]),
});

export type VerifyIntegrationConnectionInput = z.input<typeof verifyIntegrationConnectionSchema>;
export interface VerifyIntegrationConnectionResult {
  integration: string;
  environment: string;
  ok: boolean;
  detail: string;
  verifiedAt: string;
}

export interface IntegrationProbeInput {
  baseUrl: string | null;
  credentialRef: string;
  integration: string;
  environment: string;
  timeoutMs: number;
}

export type IntegrationProbe = (
  input: IntegrationProbeInput,
) => Promise<{ ok: boolean; detail?: string }>;

const defaultProbe: IntegrationProbe = async (input) => {
  if (!input.baseUrl) return { ok: false, detail: "No base URL configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.baseUrl, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    return {
      ok: response.ok || response.status === 405,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Connection failed" };
  } finally {
    clearTimeout(timer);
  }
};

export async function verifyIntegrationConnection(
  input: VerifyIntegrationConnectionInput,
  options: CommandOptions & { probe?: IntegrationProbe } = {},
): Promise<VerifyIntegrationConnectionResult> {
  const values = verifyIntegrationConnectionSchema.parse(input);
  const userId = actorId(values);
  const probe = options.probe ?? defaultProbe;

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "verifyIntegrationConnection",
    async (tx) => {
      const rows = await tx
        .select()
        .from(integrationSettings)
        .where(
          and(
            eq(integrationSettings.facilityId, values.facilityId),
            eq(integrationSettings.integration, values.integration),
            eq(integrationSettings.environment, values.environment),
          ),
        )
        .limit(1)
        .for("update");
      const setting = rows[0];
      if (!setting) {
        throw new Error(
          `No ${values.integration} ${values.environment} connection is configured for this facility`,
        );
      }

      const result = await probe({
        baseUrl: setting.baseUrl,
        credentialRef: setting.credentialRef ?? "",
        integration: setting.integration,
        environment: setting.environment,
        timeoutMs: setting.timeoutMs,
      });

      if (!result.ok) {
        await recordAudit(tx, {
          ...auditMeta(values),
          action: "regulatory.integration.verify_failed",
          entity: "integration_settings",
          entityId: setting.id,
          details: {
            integration: values.integration,
            environment: values.environment,
            detail: result.detail ?? "Connection failed",
          },
        });
        throw new Error(
          `${values.integration} ${values.environment} connection failed: ${result.detail ?? "unknown error"}`,
        );
      }

      const verifiedAt = new Date();
      await tx
        .update(integrationSettings)
        .set({
          lastVerifiedAt: verifiedAt,
          lastVerifiedBy: userId,
          updatedAt: verifiedAt,
          version: sql`${integrationSettings.version} + 1`,
        })
        .where(eq(integrationSettings.id, setting.id));

      await recordAudit(tx, {
        ...auditMeta(values),
        action: "regulatory.integration.verified",
        entity: "integration_settings",
        entityId: setting.id,
        details: {
          integration: values.integration,
          environment: values.environment,
          detail: result.detail ?? "ok",
        },
      });

      return {
        integration: values.integration,
        environment: values.environment,
        ok: true,
        detail: result.detail ?? "ok",
        verifiedAt: verifiedAt.toISOString(),
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Readiness guard                                                     */
/* ------------------------------------------------------------------ */

export type ReadinessAction = "billing" | "claiming" | "reporting" | "any";

export interface FacilityReadinessDecision {
  facilityId: string;
  action: ReadinessAction;
  allowed: boolean;
  enforcement: "advisory" | "enforced";
  blocked: ReadinessDomainResult[];
  warnings: ReadinessDomainResult[];
  missingSettings: string[];
}

export class FacilityNotReadyError extends Error {
  readonly decision: FacilityReadinessDecision;

  constructor(decision: FacilityReadinessDecision) {
    super(describeDecision(decision));
    this.name = "FacilityNotReadyError";
    this.decision = decision;
  }
}

function describeDecision(decision: FacilityReadinessDecision): string {
  const parts: string[] = [];
  for (const domain of decision.blocked) {
    parts.push(`${domain.detail} is ${domain.status}`);
  }
  for (const key of decision.missingSettings) {
    parts.push(`${key} is not configured`);
  }
  return `The facility is not ready for ${decision.action}: ${parts.join("; ")}`;
}

const ACTION_DOMAINS: Record<ReadinessAction, RegulatoryDomain[]> = {
  billing: ["kmpdc", "tax"],
  claiming: ["kmpdc", "sha", "tax"],
  reporting: ["kmpdc", "odpc", "tax"],
  any: [...REGULATORY_DOMAINS],
};

const ACTION_REQUIRED_SETTINGS: Record<ReadinessAction, Array<[SettingDomain, string]>> = {
  billing: [["tax", "invoice_prefix"]],
  claiming: [],
  reporting: [["reporting", "khis_submission_mode"]],
  any: [],
};

export async function evaluateFacilityReadiness(
  database: typeof db,
  facilityId: string,
  action: ReadinessAction,
  today: string = todayIso(),
): Promise<FacilityReadinessDecision> {
  const report = await getFacilityReadinessStatus(database, facilityId, { today });
  const domains = new Set(ACTION_DOMAINS[action]);
  const relevant = report.domains.filter((domain) => domains.has(domain.domain));

  const enforcementSetting = await database
    .select({ valueText: facilitySettings.valueText })
    .from(facilitySettings)
    .where(
      and(
        eq(facilitySettings.facilityId, facilityId),
        eq(facilitySettings.domain, "regulatory"),
        eq(facilitySettings.key, "enforcement_mode"),
        lte(facilitySettings.effectiveFrom, today),
        or(isNull(facilitySettings.effectiveTo), gte(facilitySettings.effectiveTo, today)),
      ),
    )
    .orderBy(desc(facilitySettings.effectiveFrom))
    .limit(1);
  const enforcement = enforcementSetting[0]?.valueText === "advisory" ? "advisory" : "enforced";

  const blocksExpired = enforcement === "enforced" && action !== "reporting";

  const blocked: ReadinessDomainResult[] = [];
  const warnings: ReadinessDomainResult[] = [];
  for (const domain of relevant) {
    if (domain.status === "expired") {
      if (blocksExpired) blocked.push(domain);
      else warnings.push(domain);
      continue;
    }
    if (domain.status === "expiring" || domain.status === "missing") warnings.push(domain);
  }

  const missingSettings: string[] = [];
  for (const [domain, key] of ACTION_REQUIRED_SETTINGS[action]) {
    const rows = await database
      .select({ id: facilitySettings.id, valueText: facilitySettings.valueText, valueNumeric: facilitySettings.valueNumeric })
      .from(facilitySettings)
      .where(
        and(
          eq(facilitySettings.facilityId, facilityId),
          eq(facilitySettings.domain, domain),
          eq(facilitySettings.key, key),
          lte(facilitySettings.effectiveFrom, today),
          or(isNull(facilitySettings.effectiveTo), gte(facilitySettings.effectiveTo, today)),
        ),
      )
      .orderBy(desc(facilitySettings.effectiveFrom))
      .limit(1);
    const row = rows[0];
    if (!row || (row.valueText === null && row.valueNumeric === null)) {
      missingSettings.push(`${domain}.${key}`);
    }
  }

  return {
    facilityId,
    action,
    allowed: blocked.length === 0 && missingSettings.length === 0,
    enforcement,
    blocked,
    warnings,
    missingSettings,
  };
}

export interface AssertFacilityReadyRequest {
  facilityId: string;
  action: ReadinessAction;
  actor?: CommandActor | null;
  today?: string;
}

/**
 * The one guard billing, claiming and reporting call. An expired licence (or a
 * required setting the action depends on) is refused and audited; a missing
 * record only warns so a fresh facility is not bricked on install day.
 */
export async function assertFacilityReady(
  request: AssertFacilityReadyRequest,
  options: CommandOptions = {},
): Promise<FacilityReadinessDecision> {
  const database = options.database ?? db;
  const decision = await evaluateFacilityReadiness(
    database,
    request.facilityId,
    request.action,
    request.today,
  );

  if (decision.allowed) return decision;

  await database.transaction(async (tx) => {
    await recordAudit(tx, {
      facilityId: request.facilityId,
      userId: request.actor?.userId ?? null,
      action: "regulatory.readiness.blocked",
      module: "regulatory",
      entity: "facilities",
      entityId: request.facilityId,
      details: {
        action: request.action,
        enforcement: decision.enforcement,
        blocked: decision.blocked.map((domain) => ({
          domain: domain.domain,
          status: domain.status,
          daysToExpiry: domain.daysToExpiry,
        })),
        missingSettings: decision.missingSettings,
      },
      deviceId: request.actor?.deviceId ?? null,
      ip: request.actor?.ip ?? null,
    });
  });

  throw new FacilityNotReadyError(decision);
}

export type { ReadinessStatus };
