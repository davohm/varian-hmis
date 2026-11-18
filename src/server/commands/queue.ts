import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { encounters, queueEntries } from "@/server/db/schema";
import { publishEvent } from "@/server/events";

import { actorSchema, runCommand, type CommandOptions } from "./run";

export const queuePatientSchema = z.object({
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
  encounterId: z.uuid(),
  department: z.string().trim().min(1).max(80).default("Triage"),
  roomId: z.uuid().nullable().optional(),
  priority: z.enum(["red", "yellow", "green", "normal"]).default("normal"),
});

export type QueuePatientInput = z.input<typeof queuePatientSchema>;
export interface QueuePatientResult {
  queueEntryId: string;
}

export async function queuePatient(
  input: QueuePatientInput,
  options: CommandOptions = {},
): Promise<QueuePatientResult> {
  const values = queuePatientSchema.parse(input);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "queuePatient",
    async (tx) => {
      const encounterRows = await tx
        .select({
          id: encounters.id,
          patientId: encounters.patientId,
          status: encounters.status,
          encounterNo: encounters.encounterNo,
        })
        .from(encounters)
        .where(and(eq(encounters.id, values.encounterId), eq(encounters.facilityId, values.facilityId)))
        .limit(1);
      const encounter = encounterRows[0];
      if (!encounter) throw new Error("Encounter not found in this facility");
      if (encounter.status !== "open") throw new Error("Only open encounters can be queued");

      const queueEntryId = newId();
      await tx.insert(queueEntries).values({
        id: queueEntryId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        department: values.department,
        roomId: values.roomId ?? null,
        priority: values.priority,
        status: "waiting",
        queuedAt: new Date(),
        createdBy: values.actor.userId ?? null,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId: values.actor.userId,
        action: "queue.enqueue",
        module: "reception",
        entity: "queue_entries",
        entityId: queueEntryId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          department: values.department,
          priority: values.priority,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "queue.queued",
        facilityId: values.facilityId,
        queueEntryId,
        encounterId: encounter.id,
        department: values.department,
      });

      return { queueEntryId };
    },
    options,
  );
}
