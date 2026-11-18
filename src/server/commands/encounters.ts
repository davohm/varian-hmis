import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { branches, encounters, facilities, patients } from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { nextFormattedNumber } from "@/server/numbering";

import { actorSchema, runCommand, type CommandOptions } from "./run";

export const startVisitSchema = z.object({
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
  patientId: z.uuid(),
  branchId: z.uuid(),
  payerType: z.enum(["cash", "sha", "insurance"]).nullable().optional(),
});

export type StartVisitInput = z.input<typeof startVisitSchema>;
export interface StartVisitResult {
  encounterId: string;
  encounterNo: string;
}

export async function startVisit(
  input: StartVisitInput,
  options: CommandOptions = {},
): Promise<StartVisitResult> {
  const values = startVisitSchema.parse(input);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "startVisit",
    async (tx) => {
      const facilityRows = await tx
        .select({ id: facilities.id, code: facilities.code })
        .from(facilities)
        .where(eq(facilities.id, values.facilityId))
        .limit(1);
      const facility = facilityRows[0];
      if (!facility) throw new Error("Facility not found");

      const branchRows = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, values.branchId), eq(branches.facilityId, facility.id)))
        .limit(1);
      if (!branchRows[0]) throw new Error("Branch does not belong to the facility");

      const patientRows = await tx
        .select({ id: patients.id, payerType: patients.payerType, mrn: patients.mrn })
        .from(patients)
        .where(and(eq(patients.id, values.patientId), eq(patients.facilityId, facility.id)))
        .limit(1);
      const patient = patientRows[0];
      if (!patient) throw new Error("Patient not found in this facility");

      const encounterNo = await nextFormattedNumber(tx, facility, "encounter");
      const encounterId = newId();
      await tx.insert(encounters).values({
        id: encounterId,
        facilityId: facility.id,
        branchId: values.branchId,
        patientId: patient.id,
        encounterNo,
        status: "open",
        payerType: values.payerType ?? patient.payerType,
        startedAt: new Date(),
        createdBy: values.actor.userId ?? null,
      });

      await recordAudit(tx, {
        facilityId: facility.id,
        userId: values.actor.userId,
        action: "encounter.start",
        module: "reception",
        entity: "encounters",
        entityId: encounterId,
        details: { encounterNo, patientId: patient.id, mrn: patient.mrn },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "encounter.started",
        facilityId: facility.id,
        encounterId,
        patientId: patient.id,
        encounterNo,
      });

      return { encounterId, encounterNo };
    },
    options,
  );
}
