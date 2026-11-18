import { eq } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { facilities, nextOfKin, patients } from "@/server/db/schema";
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

export async function registerPatient(
  input: RegisterPatientInput,
  options: CommandOptions = {},
): Promise<RegisterPatientResult> {
  const values = registerPatientSchema.parse(input);
  const dob = clean(values.dob) ?? (values.estimatedAge != null ? dateOfBirthFromAge(values.estimatedAge) : null);
  if (!dob) throw new Error("Provide a date of birth or an estimated age");

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
