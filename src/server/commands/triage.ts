import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  TRIAGE_CATEGORIES,
  VITAL_INPUT_LIMITS,
  assessVitals,
  calculateBmi,
  deriveTriageCategory,
  hasAnyVital,
  isCategoryAtLeast,
  type MeasurementKey,
  type TriageCategory,
} from "@/lib/triage";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { encounters, patients, queueEntries, rooms, triageVitals } from "@/server/db/schema";
import { publishEvent } from "@/server/events";

import { actorSchema, runCommand, type CommandOptions } from "./run";

function vitalNumber(key: MeasurementKey) {
  const limits = VITAL_INPUT_LIMITS[key];
  return z.number().finite().min(limits.min).max(limits.max).nullable().optional();
}

export const recordTriageVitalsSchema = z
  .object({
    facilityId: z.uuid(),
    idempotencyKey: z.uuid(),
    actor: actorSchema,
    encounterId: z.uuid(),
    queueEntryId: z.uuid(),
    roomId: z.uuid().nullable().optional(),
    systolic: vitalNumber("systolic"),
    diastolic: vitalNumber("diastolic"),
    heartRate: vitalNumber("heartRate"),
    respRate: vitalNumber("respRate"),
    temperature: vitalNumber("temperature"),
    spo2: vitalNumber("spo2"),
    weightKg: vitalNumber("weightKg"),
    heightCm: vitalNumber("heightCm"),
    painScore: vitalNumber("painScore"),
    muacCm: vitalNumber("muacCm"),
    category: z.enum(TRIAGE_CATEGORIES),
    chiefComplaint: z.string().trim().min(2).max(500),
    comments: z.string().trim().max(1_000).nullable().optional(),
    nextSteps: z.string().trim().max(1_000).nullable().optional(),
  })
  .superRefine((values, context) => {
    if (!hasAnyVital(values)) {
      context.addIssue({
        code: "custom",
        path: ["systolic"],
        message: "Record at least one vital sign",
      });
    }

    if ((values.systolic == null) !== (values.diastolic == null)) {
      context.addIssue({
        code: "custom",
        path: ["diastolic"],
        message: "Enter both systolic and diastolic blood pressure",
      });
    }

    const suggested = deriveTriageCategory(assessVitals(values));
    if (!isCategoryAtLeast(values.category, suggested)) {
      context.addIssue({
        code: "custom",
        path: ["category"],
        message: `Vitals require a ${suggested} category or higher`,
      });
    }
  });

export type RecordTriageVitalsInput = z.input<typeof recordTriageVitalsSchema>;

export interface RecordTriageVitalsResult {
  triageVitalsId: string;
  doctorQueueEntryId: string;
  bmi: number | null;
  category: TriageCategory;
  suggestedCategory: TriageCategory;
}

export const callTriagePatientSchema = z.object({
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
  queueEntryId: z.uuid(),
});

export type CallTriagePatientInput = z.input<typeof callTriagePatientSchema>;

export interface CallTriagePatientResult {
  queueEntryId: string;
  status: "called";
}

const ACTIVE_QUEUE_STATUSES: readonly string[] = ["waiting", "called", "in_service"];

export async function recordTriageVitals(
  input: RecordTriageVitalsInput,
  options: CommandOptions = {},
): Promise<RecordTriageVitalsResult> {
  const values = recordTriageVitalsSchema.parse(input);
  if (!values.actor.userId) {
    throw new Error("A signed-in user is required to record triage vitals");
  }
  const actorUserId = values.actor.userId;

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordTriageVitals",
    async (tx) => {
      const encounterRows = await tx
        .select({
          id: encounters.id,
          patientId: encounters.patientId,
          encounterNo: encounters.encounterNo,
          status: encounters.status,
          mrn: patients.mrn,
          firstName: patients.firstName,
          lastName: patients.lastName,
        })
        .from(encounters)
        .innerJoin(
          patients,
          and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)),
        )
        .where(
          and(
            eq(encounters.id, values.encounterId),
            eq(encounters.facilityId, values.facilityId),
          ),
        )
        .limit(1);
      const encounter = encounterRows[0];
      if (!encounter) throw new Error("Encounter not found in this facility");
      if (encounter.status !== "open") throw new Error("Only open encounters can be triaged");

      const queueRows = await tx
        .select()
        .from(queueEntries)
        .where(
          and(
            eq(queueEntries.id, values.queueEntryId),
            eq(queueEntries.facilityId, values.facilityId),
            eq(queueEntries.encounterId, encounter.id),
            eq(queueEntries.department, "Triage"),
          ),
        )
        .limit(1)
        .for("update");
      const triageQueueEntry = queueRows[0];
      if (!triageQueueEntry) {
        throw new Error("Triage queue entry not found in this facility");
      }
      if (!ACTIVE_QUEUE_STATUSES.includes(triageQueueEntry.status)) {
        throw new Error("This patient is no longer waiting for triage");
      }

      if (values.roomId) {
        const roomRows = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.id, values.roomId), eq(rooms.facilityId, values.facilityId)))
          .limit(1);
        if (!roomRows[0]) throw new Error("Room does not belong to the facility");
      }

      const assessments = assessVitals(values);
      const suggestedCategory = deriveTriageCategory(assessments);
      const bmi = calculateBmi(values.weightKg, values.heightCm);
      const triageVitalsId = newId();
      const doctorQueueEntryId = newId();
      const now = new Date();

      await tx.insert(triageVitals).values({
        id: triageVitalsId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        systolic: values.systolic ?? null,
        diastolic: values.diastolic ?? null,
        heartRate: values.heartRate ?? null,
        respRate: values.respRate ?? null,
        temperature: values.temperature == null ? null : values.temperature.toFixed(1),
        spo2: values.spo2 ?? null,
        weightKg: values.weightKg == null ? null : values.weightKg.toFixed(2),
        heightCm: values.heightCm == null ? null : values.heightCm.toFixed(1),
        bmi: bmi == null ? null : bmi.toFixed(1),
        painScore: values.painScore ?? null,
        muacCm: values.muacCm == null ? null : values.muacCm.toFixed(1),
        category: values.category,
        chiefComplaint: values.chiefComplaint,
        comments: values.comments?.trim() || null,
        nextSteps: values.nextSteps?.trim() || null,
        recordedBy: actorUserId,
        createdBy: actorUserId,
      });

      await tx
        .update(queueEntries)
        .set({
          status: "done",
          priority: values.category,
          doneAt: now,
          updatedAt: now,
          version: sql`${queueEntries.version} + 1`,
        })
        .where(
          and(
            eq(queueEntries.id, triageQueueEntry.id),
            eq(queueEntries.facilityId, values.facilityId),
          ),
        );

      await tx.insert(queueEntries).values({
        id: doctorQueueEntryId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        department: "Doctor",
        roomId: values.roomId ?? null,
        priority: values.category,
        status: "waiting",
        queuedAt: now,
        createdBy: actorUserId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId: actorUserId,
        action: "triage.record",
        module: "triage",
        entity: "triage_vitals",
        entityId: triageVitalsId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          patientId: encounter.patientId,
          mrn: encounter.mrn,
          category: values.category,
          suggestedCategory,
          bmi,
          doctorQueueEntryId,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      await publishEvent(tx, {
        type: "triage.recorded",
        facilityId: values.facilityId,
        triageVitalsId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        category: values.category,
        doctorQueueEntryId,
      });
      await publishEvent(tx, {
        type: "queue.queued",
        facilityId: values.facilityId,
        queueEntryId: doctorQueueEntryId,
        encounterId: encounter.id,
        department: "Doctor",
        priority: values.category,
      });

      return {
        triageVitalsId,
        doctorQueueEntryId,
        bmi,
        category: values.category,
        suggestedCategory,
      };
    },
    options,
  );
}

/** Marks a waiting patient as called so the station and the queue agree. */
export async function callTriagePatient(
  input: CallTriagePatientInput,
  options: CommandOptions = {},
): Promise<CallTriagePatientResult> {
  const values = callTriagePatientSchema.parse(input);
  if (!values.actor.userId) {
    throw new Error("A signed-in user is required to call a patient");
  }
  const actorUserId = values.actor.userId;

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "callTriagePatient",
    async (tx) => {
      const rows = await tx
        .select({
          id: queueEntries.id,
          status: queueEntries.status,
          encounterId: queueEntries.encounterId,
          encounterNo: encounters.encounterNo,
          patientId: queueEntries.patientId,
          mrn: patients.mrn,
          firstName: patients.firstName,
          lastName: patients.lastName,
        })
        .from(queueEntries)
        .innerJoin(
          encounters,
          and(eq(encounters.id, queueEntries.encounterId), eq(encounters.facilityId, values.facilityId)),
        )
        .innerJoin(
          patients,
          and(eq(patients.id, queueEntries.patientId), eq(patients.facilityId, values.facilityId)),
        )
        .where(
          and(
            eq(queueEntries.id, values.queueEntryId),
            eq(queueEntries.facilityId, values.facilityId),
            eq(queueEntries.department, "Triage"),
          ),
        )
        .limit(1)
        .for("update");
      const entry = rows[0];
      if (!entry) throw new Error("Triage queue entry not found in this facility");
      if (entry.status === "done" || entry.status === "cancelled") {
        throw new Error("This patient is no longer waiting for triage");
      }

      // A second nurse pressing Call must not create a second audit row.
      if (entry.status !== "called") {
        const now = new Date();
        await tx
          .update(queueEntries)
          .set({
            status: "called",
            calledAt: now,
            updatedAt: now,
            version: sql`${queueEntries.version} + 1`,
          })
          .where(
            and(
              eq(queueEntries.id, entry.id),
              eq(queueEntries.facilityId, values.facilityId),
            ),
          );

        await recordAudit(tx, {
          facilityId: values.facilityId,
          userId: actorUserId,
          action: "triage.call",
          module: "triage",
          entity: "queue_entries",
          entityId: entry.id,
          details: {
            encounterId: entry.encounterId,
            encounterNo: entry.encounterNo,
            patientId: entry.patientId,
            mrn: entry.mrn,
            patientName: `${entry.firstName} ${entry.lastName}`,
            fromStatus: entry.status,
          },
          deviceId: values.actor.deviceId,
          ip: values.actor.ip,
        });
        await publishEvent(tx, {
          type: "triage.called",
          facilityId: values.facilityId,
          queueEntryId: entry.id,
          encounterId: entry.encounterId,
          patientId: entry.patientId,
        });
      }

      return { queueEntryId: entry.id, status: "called" as const };
    },
    options,
  );
}
