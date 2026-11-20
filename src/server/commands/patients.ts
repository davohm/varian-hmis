import { eq } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { dataConsents, facilities, nextOfKin, patients } from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { nextFormattedNumber } from "@/server/numbering";
import { findPatientDuplicates } from "@/server/queries/patients";

import { actorSchema, runCommand, type CommandOptions } from "./run";

const phoneSchema = z.string().trim().min(7).max(30).nullable().optional();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const nextOfKinSchema = z.object({
  name: z.string().trim().min(1).max(120),
  relationship: z.string().trim().min(1).max(60),
  phone: phoneSchema,
});

const minorConsentSchema = z.object({
  consentType: z.literal("minor"),
  consentVersion: z.string().trim().min(1).max(64),
  consentTextHash: z.string().trim().max(128).nullable().optional(),
  granted: z.literal(true),
  grantedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  grantedBy: z.string().trim().min(1).max(128),
  source: z.string().trim().max(64).nullable().optional(),
  documentId: z.uuid().nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).or(z.string().datetime()).nullable().optional(),
  validTo: z.string().datetime({ offset: true }).or(z.string().datetime()).nullable().optional(),
});

const treatmentConsentSchema = z.object({
  consentType: z.literal("treatment"),
  consentVersion: z.string().trim().min(1).max(64),
  consentTextHash: z.string().trim().max(128).nullable().optional(),
  granted: z.literal(true),
  grantedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  grantedBy: z.string().trim().min(1).max(128),
  source: z.string().trim().max(64).nullable().optional(),
  documentId: z.uuid().nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).or(z.string().datetime()).nullable().optional(),
  validTo: z.string().datetime({ offset: true }).or(z.string().datetime()).nullable().optional(),
});

export const registerPatientSchema = z
  .object({
    facilityId: z.uuid(),
    idempotencyKey: z.uuid(),
    actor: actorSchema,
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    otherNames: z.string().trim().max(120).nullable().optional(),
    dob: isoDateSchema.nullable().optional(),
    dobEstimated: z.boolean().default(false),
    estimatedAge: z.number().int().min(0).max(120).nullable().optional(),
    sex: z.enum(["male", "female", "other"]),
    nationalId: z.string().trim().max(64).nullable().optional(),
    phone: phoneSchema,
    email: z.string().trim().max(255).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    payerType: z.enum(["cash", "sha", "insurance"]).default("cash"),
    payerMemberNo: z.string().trim().max(64).nullable().optional(),
    allergies: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    bloodGroup: z.string().trim().max(8).nullable().optional(),
    nextOfKin: z.array(nextOfKinSchema).max(4).default([]),
    minorConsent: minorConsentSchema.optional(),
    treatmentConsent: treatmentConsentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.dob && value.estimatedAge == null) {
      context.addIssue({
        code: "custom",
        path: ["dob"],
        message: "Provide a date of birth or an estimated age",
      });
    }
  });

export type RegisterPatientInput = z.input<typeof registerPatientSchema>;
export interface RegisterPatientResult {
  patientId: string;
  mrn: string;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function dateOfBirthFromAge(age: number): string {
  const year = new Date().getUTCFullYear() - age;
  return `${String(year).padStart(4, "0")}-01-01`;
}

function isMinorDob(dob: string): boolean {
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  const ageMs = Date.now() - birth.getTime();
  return ageMs / (365.25 * 24 * 60 * 60 * 1000) < 18;
}

export async function registerPatient(
  input: RegisterPatientInput,
  options: CommandOptions = {},
): Promise<RegisterPatientResult> {
  const values = registerPatientSchema.parse(input);
  const dob = clean(values.dob) ?? (values.estimatedAge != null ? dateOfBirthFromAge(values.estimatedAge) : null);
  if (!dob) throw new Error("Provide a date of birth or an estimated age");
  const minor = isMinorDob(dob);
  if (minor) {
    if (values.nextOfKin.length === 0) {
      throw new Error("A guardian or next of kin is required when registering a minor");
    }
    if (!values.minorConsent || values.minorConsent.consentType !== "minor" || values.minorConsent.granted !== true) {
      throw new Error("A guardian consent record is required when registering a minor");
    }
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "registerPatient",
    async (tx) => {
      const facilityRows = await tx
        .select({ id: facilities.id, code: facilities.code })
        .from(facilities)
        .where(eq(facilities.id, values.facilityId))
        .limit(1);
      const facility = facilityRows[0];
      if (!facility) throw new Error("Facility not found");

      const mrn = await nextFormattedNumber(tx, facility, "mrn");
      const patientId = newId();
      const phone = clean(values.phone);
      const nationalId = clean(values.nationalId);
      const duplicates = await findPatientDuplicates(tx, facility.id, {
        phone,
        dob,
        nationalId,
      });

      await tx.insert(patients).values({
        id: patientId,
        facilityId: facility.id,
        mrn,
        firstName: values.firstName,
        lastName: values.lastName,
        otherNames: clean(values.otherNames),
        dob,
        dobEstimated: values.estimatedAge != null || values.dobEstimated,
        sex: values.sex,
        nationalId,
        phone,
        email: clean(values.email),
        address: clean(values.address),
        payerType: values.payerType,
        payerMemberNo: clean(values.payerMemberNo),
        allergies: values.allergies,
        bloodGroup: clean(values.bloodGroup),
        createdBy: values.actor.userId ?? null,
      });

      if (values.nextOfKin.length > 0) {
        await tx.insert(nextOfKin).values(
          values.nextOfKin.map((kin) => ({
            id: newId(),
            facilityId: facility.id,
            patientId,
            name: kin.name,
            relationship: kin.relationship,
            phone: clean(kin.phone),
            createdBy: values.actor.userId ?? null,
          })),
        );
      }

      if (minor && values.minorConsent) {
        const consent = values.minorConsent;
        const insertedConsent = await tx
          .insert(dataConsents)
          .values({
            facilityId: facility.id,
            patientId,
            consentType: consent.consentType,
            consentVersion: consent.consentVersion,
            consentTextHash: consent.consentTextHash ?? null,
            granted: consent.granted,
            grantedAt: new Date(consent.grantedAt),
            grantedBy: consent.grantedBy,
            withdrawnAt: null,
            withdrawnBy: null,
            source: consent.source ?? "registration",
            documentId: consent.documentId ?? null,
            validFrom: consent.validFrom ? new Date(consent.validFrom) : null,
            validTo: consent.validTo ? new Date(consent.validTo) : null,
            createdBy: values.actor.userId ?? null,
          })
          .returning({ id: dataConsents.id });
        const consentId = insertedConsent[0]!.id;

        await recordAudit(tx, {
          facilityId: facility.id,
          userId: values.actor.userId,
          action: "privacy.consent.record",
          module: "privacy",
          entity: "data_consents",
          entityId: consentId,
          details: {
            patientId,
            consentType: consent.consentType,
            consentVersion: consent.consentVersion,
            granted: consent.granted,
            recordedAtRegistration: true,
          },
          deviceId: values.actor.deviceId,
          ip: values.actor.ip,
        });

        await publishEvent(tx, {
          type: "privacy.consent.recorded",
          facilityId: facility.id,
          patientId,
          consentType: consent.consentType,
          consentVersion: consent.consentVersion,
        });
      }

      if (values.treatmentConsent) {
        const consent = values.treatmentConsent;
        const insertedConsent = await tx
          .insert(dataConsents)
          .values({
            facilityId: facility.id,
            patientId,
            consentType: consent.consentType,
            consentVersion: consent.consentVersion,
            consentTextHash: consent.consentTextHash ?? null,
            granted: consent.granted,
            grantedAt: new Date(consent.grantedAt),
            grantedBy: consent.grantedBy,
            withdrawnAt: null,
            withdrawnBy: null,
            source: consent.source ?? "registration",
            documentId: consent.documentId ?? null,
            validFrom: consent.validFrom ? new Date(consent.validFrom) : null,
            validTo: consent.validTo ? new Date(consent.validTo) : null,
            createdBy: values.actor.userId ?? null,
          })
          .returning({ id: dataConsents.id });
        const consentId = insertedConsent[0]!.id;

        await recordAudit(tx, {
          facilityId: facility.id,
          userId: values.actor.userId,
          action: "privacy.consent.record",
          module: "privacy",
          entity: "data_consents",
          entityId: consentId,
          details: {
            patientId,
            consentType: consent.consentType,
            consentVersion: consent.consentVersion,
            granted: consent.granted,
            recordedAtRegistration: true,
          },
          deviceId: values.actor.deviceId,
          ip: values.actor.ip,
        });

        await publishEvent(tx, {
          type: "privacy.consent.recorded",
          facilityId: facility.id,
          patientId,
          consentType: consent.consentType,
          consentVersion: consent.consentVersion,
        });
      }

      await recordAudit(tx, {
        facilityId: facility.id,
        userId: values.actor.userId,
        action: "patient.register",
        module: "reception",
        entity: "patients",
        entityId: patientId,
        details: { mrn, duplicateCount: duplicates.length },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "patient.registered",
        facilityId: facility.id,
        patientId,
        mrn,
      });

      return { patientId, mrn };
    },
    options,
  );
}
