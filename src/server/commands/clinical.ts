import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ACTIVE_LAB_ORDER_STATUSES,
  CLINICAL_NOTE_LOCKED_MESSAGE,
  CLOSED_ENCOUNTER_MESSAGE,
  DISCHARGE_OUTCOMES,
  OPEN_ENCOUNTER_MESSAGE,
  OUTSTANDING_LAB_MESSAGE,
  PRESCRIPTION_FREQUENCIES,
  PRESCRIPTION_ROUTES,
  canCancelLabOrder,
  canCancelPrescription,
} from "@/lib/clinical";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { syncEncounterCharges } from "@/server/charges";
import {
  clinicalNotes,
  diagnoses,
  encounters,
  icd10Codes,
  items,
  labOrderItems,
  labOrders,
  labTests,
  prescriptions,
  queueEntries,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const ACTIVE_QUEUE_STATUSES = ["waiting", "called", "in_service"] as const;

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
  encounterId: z.uuid(),
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

/**
 * Keep the visit's billable lines in step with the clinical record. The sync
 * only touches charges that are not locked on a paid or void invoice.
 */
async function syncBill(
  tx: CommandTransaction,
  values: {
    facilityId: string;
    actor: { userId?: string | null; ip?: string | null; deviceId?: string | null };
  },
  encounterId: string,
): Promise<void> {
  await syncEncounterCharges(tx, {
    facilityId: values.facilityId,
    encounterId,
    actor: {
      userId: actorId(values),
      ip: values.actor.ip,
      deviceId: values.actor.deviceId,
    },
  });
}

interface LoadedEncounter {
  id: string;
  patientId: string;
  encounterNo: string;
  status: string;
}

async function loadEncounter(
  tx: CommandTransaction,
  facilityId: string,
  encounterId: string,
): Promise<LoadedEncounter> {
  const rows = await tx
    .select({
      id: encounters.id,
      patientId: encounters.patientId,
      encounterNo: encounters.encounterNo,
      status: encounters.status,
    })
    .from(encounters)
    .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)))
    .limit(1);
  const encounter = rows[0];
  if (!encounter) throw new Error("Encounter not found in this facility");
  return encounter;
}

async function loadOpenEncounter(
  tx: CommandTransaction,
  facilityId: string,
  encounterId: string,
): Promise<LoadedEncounter> {
  const encounter = await loadEncounter(tx, facilityId, encounterId);
  if (encounter.status !== "open") throw new Error(OPEN_ENCOUNTER_MESSAGE);
  return encounter;
}

/* ------------------------------------------------------------------ */
/* Start consultation                                                  */
/* ------------------------------------------------------------------ */

export const startConsultationSchema = z.object({
  ...baseSchema,
  queueEntryId: z.uuid().nullable().optional(),
});

export type StartConsultationInput = z.input<typeof startConsultationSchema>;
export interface StartConsultationResult {
  encounterId: string;
  queueEntryId: string;
  status: "in_service";
}

export async function startConsultation(
  input: StartConsultationInput,
  options: CommandOptions = {},
): Promise<StartConsultationResult> {
  const values = startConsultationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "startConsultation",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);

      const conditions = [
        eq(queueEntries.facilityId, values.facilityId),
        eq(queueEntries.encounterId, encounter.id),
        eq(queueEntries.department, "Doctor"),
        inArray(queueEntries.status, [...ACTIVE_QUEUE_STATUSES]),
      ];
      if (values.queueEntryId) {
        conditions.push(eq(queueEntries.id, values.queueEntryId));
      }

      const queueRows = await tx
        .select()
        .from(queueEntries)
        .where(and(...conditions))
        .limit(1)
        .for("update");
      const queueEntry = queueRows[0];
      if (!queueEntry) throw new Error("This patient is not waiting for a doctor");

      if (queueEntry.status !== "in_service") {
        const now = new Date();
        await tx
          .update(queueEntries)
          .set({
            status: "in_service",
            calledAt: queueEntry.calledAt ?? now,
            updatedAt: now,
            version: sql`${queueEntries.version} + 1`,
          })
          .where(
            and(
              eq(queueEntries.id, queueEntry.id),
              eq(queueEntries.facilityId, values.facilityId),
            ),
          );

        await recordAudit(tx, {
          facilityId: values.facilityId,
          userId,
          action: "consultation.start",
          module: "doctor",
          entity: "queue_entries",
          entityId: queueEntry.id,
          details: {
            encounterId: encounter.id,
            encounterNo: encounter.encounterNo,
            patientId: encounter.patientId,
          },
          deviceId: values.actor.deviceId,
          ip: values.actor.ip,
        });
        await publishEvent(tx, {
          type: "consultation.started",
          facilityId: values.facilityId,
          encounterId: encounter.id,
          patientId: encounter.patientId,
          queueEntryId: queueEntry.id,
        });
        await publishEvent(tx, {
          type: "queue.changed",
          facilityId: values.facilityId,
          queueEntryId: queueEntry.id,
          encounterId: encounter.id,
          department: "Doctor",
          status: "in_service",
        });
      }

      await syncBill(tx, values, encounter.id);

      return { encounterId: encounter.id, queueEntryId: queueEntry.id, status: "in_service" };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* SOAP note                                                           */
/* ------------------------------------------------------------------ */

const noteText = z.string().trim().max(5_000).nullable().optional();

export const saveClinicalNoteSchema = z.object({
  ...baseSchema,
  subjective: noteText,
  objective: noteText,
  assessment: noteText,
  plan: noteText,
  sign: z.boolean().default(false),
});

export type SaveClinicalNoteInput = z.input<typeof saveClinicalNoteSchema>;
export interface SaveClinicalNoteResult {
  noteId: string;
  signedAt: string | null;
}

export async function saveClinicalNote(
  input: SaveClinicalNoteInput,
  options: CommandOptions = {},
): Promise<SaveClinicalNoteResult> {
  const values = saveClinicalNoteSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "saveClinicalNote",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);

      const existingRows = await tx
        .select()
        .from(clinicalNotes)
        .where(
          and(
            eq(clinicalNotes.facilityId, values.facilityId),
            eq(clinicalNotes.encounterId, encounter.id),
          ),
        )
        .orderBy(sql`${clinicalNotes.createdAt} DESC`)
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (existing?.signedAt) throw new Error(CLINICAL_NOTE_LOCKED_MESSAGE);

      const merge = <T>(next: T | null | undefined, current: T | null | undefined) =>
        next === undefined ? (current ?? null) : next;

      const content = {
        subjective: merge(values.subjective, existing?.subjective),
        objective: merge(values.objective, existing?.objective),
        assessment: merge(values.assessment, existing?.assessment),
        plan: merge(values.plan, existing?.plan),
      };
      const hasContent = Object.values(content).some((value) => (value ?? "").trim().length > 0);
      if (!hasContent) throw new Error("Write at least one section of the clinical note");

      if (values.sign && (!content.assessment?.trim() || !content.plan?.trim())) {
        throw new Error("Assessment and plan are required before signing the note");
      }

      const now = new Date();
      const signedAt = values.sign ? now : (existing?.signedAt ?? null);
      let noteId: string;

      if (existing) {
        noteId = existing.id;
        await tx
          .update(clinicalNotes)
          .set({
            ...content,
            signedAt,
            updatedAt: now,
            version: sql`${clinicalNotes.version} + 1`,
          })
          .where(
            and(
              eq(clinicalNotes.id, existing.id),
              eq(clinicalNotes.facilityId, values.facilityId),
            ),
          );
      } else {
        noteId = newId();
        await tx.insert(clinicalNotes).values({
          id: noteId,
          facilityId: values.facilityId,
          encounterId: encounter.id,
          ...content,
          authorId: userId,
          signedAt,
          createdBy: userId,
        });
      }

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: values.sign ? "clinical_note.sign" : "clinical_note.save",
        module: "doctor",
        entity: "clinical_notes",
        entityId: noteId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          signed: values.sign,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "clinical_note.saved",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        noteId,
        signed: values.sign,
      });

      return { noteId, signedAt: signedAt ? signedAt.toISOString() : null };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Diagnoses                                                           */
/* ------------------------------------------------------------------ */

export const recordDiagnosisSchema = z.object({
  ...baseSchema,
  icd10Code: z.string().trim().min(2).max(16),
  isPrimary: z.boolean().default(false),
});

export type RecordDiagnosisInput = z.input<typeof recordDiagnosisSchema>;
export interface RecordDiagnosisResult {
  diagnosisId: string;
  code: string;
  description: string;
  isPrimary: boolean;
}

export async function recordDiagnosis(
  input: RecordDiagnosisInput,
  options: CommandOptions = {},
): Promise<RecordDiagnosisResult> {
  const values = recordDiagnosisSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordDiagnosis",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);
      const code = values.icd10Code.toUpperCase();

      const catalogRows = await tx
        .select({ code: icd10Codes.code, description: icd10Codes.description })
        .from(icd10Codes)
        .where(eq(icd10Codes.code, code))
        .limit(1);
      const catalog = catalogRows[0];
      if (!catalog) throw new Error(`Unknown ICD-10 code: ${code}`);

      const duplicateRows = await tx
        .select({ id: diagnoses.id })
        .from(diagnoses)
        .where(
          and(
            eq(diagnoses.facilityId, values.facilityId),
            eq(diagnoses.encounterId, encounter.id),
            eq(diagnoses.icd10Code, code),
            isNull(diagnoses.voidedAt),
          ),
        )
        .limit(1);
      if (duplicateRows[0]) throw new Error(`${code} is already recorded for this visit`);

      const now = new Date();
      if (values.isPrimary) {
        await tx
          .update(diagnoses)
          .set({
            isPrimary: false,
            updatedAt: now,
            version: sql`${diagnoses.version} + 1`,
          })
          .where(
            and(
              eq(diagnoses.facilityId, values.facilityId),
              eq(diagnoses.encounterId, encounter.id),
              eq(diagnoses.isPrimary, true),
              isNull(diagnoses.voidedAt),
            ),
          );
      }

      const diagnosisId = newId();
      await tx.insert(diagnoses).values({
        id: diagnosisId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        icd10Code: catalog.code,
        description: catalog.description,
        isPrimary: values.isPrimary,
        diagnosedBy: userId,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "diagnosis.record",
        module: "doctor",
        entity: "diagnoses",
        entityId: diagnosisId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          code: catalog.code,
          isPrimary: values.isPrimary,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "diagnosis.recorded",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        diagnosisId,
        code: catalog.code,
      });

      return {
        diagnosisId,
        code: catalog.code,
        description: catalog.description,
        isPrimary: values.isPrimary,
      };
    },
    options,
  );
}

export const voidDiagnosisSchema = z.object({
  ...baseSchema,
  diagnosisId: z.uuid(),
});

export type VoidDiagnosisInput = z.input<typeof voidDiagnosisSchema>;
export interface VoidDiagnosisResult {
  diagnosisId: string;
}

export async function voidDiagnosis(
  input: VoidDiagnosisInput,
  options: CommandOptions = {},
): Promise<VoidDiagnosisResult> {
  const values = voidDiagnosisSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "voidDiagnosis",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);

      const rows = await tx
        .select()
        .from(diagnoses)
        .where(
          and(
            eq(diagnoses.id, values.diagnosisId),
            eq(diagnoses.facilityId, values.facilityId),
            eq(diagnoses.encounterId, encounter.id),
          ),
        )
        .limit(1)
        .for("update");
      const diagnosis = rows[0];
      if (!diagnosis) throw new Error("Diagnosis not found for this visit");
      if (diagnosis.voidedAt) throw new Error("This diagnosis is already voided");

      const now = new Date();
      await tx
        .update(diagnoses)
        .set({
          voidedAt: now,
          voidedBy: userId,
          updatedAt: now,
          version: sql`${diagnoses.version} + 1`,
        })
        .where(and(eq(diagnoses.id, diagnosis.id), eq(diagnoses.facilityId, values.facilityId)));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "diagnosis.void",
        module: "doctor",
        entity: "diagnoses",
        entityId: diagnosis.id,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          code: diagnosis.icd10Code,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "diagnosis.voided",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        diagnosisId: diagnosis.id,
      });

      return { diagnosisId: diagnosis.id };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Lab orders                                                          */
/* ------------------------------------------------------------------ */

export const orderLabTestsSchema = z.object({
  ...baseSchema,
  labTestIds: z.array(z.uuid()).min(1).max(30),
  clinicalNotes: z.string().trim().max(2_000).nullable().optional(),
});

export type OrderLabTestsInput = z.input<typeof orderLabTestsSchema>;
export interface OrderLabTestsResult {
  labOrderId: string;
  itemIds: string[];
  status: "ordered";
}

export async function orderLabTests(
  input: OrderLabTestsInput,
  options: CommandOptions = {},
): Promise<OrderLabTestsResult> {
  const values = orderLabTestsSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "orderLabTests",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);
      const testIds = Array.from(new Set(values.labTestIds));

      const available = await tx
        .select({ id: labTests.id, code: labTests.code })
        .from(labTests)
        .where(
          and(
            inArray(labTests.id, testIds),
            or(isNull(labTests.facilityId), eq(labTests.facilityId, values.facilityId)),
          ),
        );
      if (available.length !== testIds.length) {
        throw new Error("One or more laboratory tests are not available at this facility");
      }

      const labOrderId = newId();
      await tx.insert(labOrders).values({
        id: labOrderId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        status: "ordered",
        clinicalNotes: values.clinicalNotes?.trim() || null,
        orderedBy: userId,
        createdBy: userId,
      });

      const itemIds: string[] = [];
      for (const test of available) {
        const itemId = newId();
        itemIds.push(itemId);
        await tx.insert(labOrderItems).values({
          id: itemId,
          facilityId: values.facilityId,
          labOrderId,
          labTestId: test.id,
          status: "ordered",
          createdBy: userId,
        });
      }

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "lab_order.create",
        module: "doctor",
        entity: "lab_orders",
        entityId: labOrderId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          tests: available.map((test) => test.code),
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "lab_order.created",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        labOrderId,
        itemIds,
        testIds: available.map((test) => test.id),
      });

      await syncBill(tx, values, encounter.id);

      return { labOrderId, itemIds, status: "ordered" as const };
    },
    options,
  );
}

export const cancelLabOrderSchema = z.object({
  ...baseSchema,
  labOrderId: z.uuid(),
});

export type CancelLabOrderInput = z.input<typeof cancelLabOrderSchema>;
export interface CancelLabOrderResult {
  labOrderId: string;
  status: "cancelled";
}

export async function cancelLabOrder(
  input: CancelLabOrderInput,
  options: CommandOptions = {},
): Promise<CancelLabOrderResult> {
  const values = cancelLabOrderSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "cancelLabOrder",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);

      const rows = await tx
        .select()
        .from(labOrders)
        .where(
          and(
            eq(labOrders.id, values.labOrderId),
            eq(labOrders.facilityId, values.facilityId),
            eq(labOrders.encounterId, encounter.id),
          ),
        )
        .limit(1)
        .for("update");
      const order = rows[0];
      if (!order) throw new Error("Laboratory order not found for this visit");
      if (order.status === "cancelled") throw new Error("This laboratory order is already cancelled");
      if (!canCancelLabOrder(order.status)) {
        throw new Error("Results have already been returned; this order cannot be cancelled");
      }

      const now = new Date();
      await tx
        .update(labOrders)
        .set({
          status: "cancelled",
          updatedAt: now,
          version: sql`${labOrders.version} + 1`,
        })
        .where(and(eq(labOrders.id, order.id), eq(labOrders.facilityId, values.facilityId)));

      await tx
        .update(labOrderItems)
        .set({
          status: "cancelled",
          updatedAt: now,
          version: sql`${labOrderItems.version} + 1`,
        })
        .where(
          and(
            eq(labOrderItems.facilityId, values.facilityId),
            eq(labOrderItems.labOrderId, order.id),
            inArray(labOrderItems.status, ["ordered", "collected"]),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "lab_order.cancel",
        module: "doctor",
        entity: "lab_orders",
        entityId: order.id,
        details: { encounterId: encounter.id, encounterNo: encounter.encounterNo },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "lab_order.cancelled",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        labOrderId: order.id,
      });

      await syncBill(tx, values, encounter.id);

      return { labOrderId: order.id, status: "cancelled" as const };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Prescriptions                                                       */
/* ------------------------------------------------------------------ */

export const prescribeSchema = z.object({
  ...baseSchema,
  itemId: z.uuid(),
  dose: z.string().trim().min(1).max(120),
  route: z.enum(PRESCRIPTION_ROUTES),
  frequency: z.enum(PRESCRIPTION_FREQUENCIES),
  durationDays: z.number().int().min(1).max(365).nullable().optional(),
  quantity: z.number().int().min(1).max(1_000),
  instructions: z.string().trim().max(1_000).nullable().optional(),
});

export type PrescribeInput = z.input<typeof prescribeSchema>;
export interface PrescribeResult {
  prescriptionId: string;
  status: "prescribed";
}

export async function prescribe(
  input: PrescribeInput,
  options: CommandOptions = {},
): Promise<PrescribeResult> {
  const values = prescribeSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "prescribe",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);

      const itemRows = await tx
        .select({ id: items.id, name: items.name, kind: items.kind })
        .from(items)
        .where(
          and(
            eq(items.id, values.itemId),
            or(isNull(items.facilityId), eq(items.facilityId, values.facilityId)),
          ),
        )
        .limit(1);
      const item = itemRows[0];
      if (!item) throw new Error("Medicine not found in this facility");
      if (item.kind !== "drug") throw new Error("Only medicines can be prescribed");

      const prescriptionId = newId();
      await tx.insert(prescriptions).values({
        id: prescriptionId,
        facilityId: values.facilityId,
        encounterId: encounter.id,
        itemId: item.id,
        dose: values.dose,
        route: values.route,
        frequency: values.frequency,
        durationDays: values.durationDays ?? null,
        quantity: values.quantity,
        instructions: values.instructions?.trim() || null,
        status: "prescribed",
        prescribedBy: userId,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "prescription.create",
        module: "doctor",
        entity: "prescriptions",
        entityId: prescriptionId,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          itemId: item.id,
          itemName: item.name,
          quantity: values.quantity,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "prescription.created",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        prescriptionId,
        itemId: item.id,
      });

      return { prescriptionId, status: "prescribed" as const };
    },
    options,
  );
}

export const cancelPrescriptionSchema = z.object({
  ...baseSchema,
  prescriptionId: z.uuid(),
});

export type CancelPrescriptionInput = z.input<typeof cancelPrescriptionSchema>;
export interface CancelPrescriptionResult {
  prescriptionId: string;
  status: "cancelled";
}

export async function cancelPrescription(
  input: CancelPrescriptionInput,
  options: CommandOptions = {},
): Promise<CancelPrescriptionResult> {
  const values = cancelPrescriptionSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "cancelPrescription",
    async (tx) => {
      const encounter = await loadOpenEncounter(tx, values.facilityId, values.encounterId);

      const rows = await tx
        .select()
        .from(prescriptions)
        .where(
          and(
            eq(prescriptions.id, values.prescriptionId),
            eq(prescriptions.facilityId, values.facilityId),
            eq(prescriptions.encounterId, encounter.id),
          ),
        )
        .limit(1)
        .for("update");
      const prescription = rows[0];
      if (!prescription) throw new Error("Prescription not found for this visit");
      if (prescription.status === "cancelled") {
        throw new Error("This prescription is already cancelled");
      }
      if (!canCancelPrescription(prescription.status)) {
        throw new Error("Dispensed prescriptions cannot be cancelled; reverse the dispense instead");
      }

      const now = new Date();
      await tx
        .update(prescriptions)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: userId,
          updatedAt: now,
          version: sql`${prescriptions.version} + 1`,
        })
        .where(
          and(
            eq(prescriptions.id, prescription.id),
            eq(prescriptions.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "prescription.cancel",
        module: "doctor",
        entity: "prescriptions",
        entityId: prescription.id,
        details: { encounterId: encounter.id, encounterNo: encounter.encounterNo },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "prescription.cancelled",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        prescriptionId: prescription.id,
      });

      await syncBill(tx, values, encounter.id);

      return { prescriptionId: prescription.id, status: "cancelled" as const };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Close the visit                                                     */
/* ------------------------------------------------------------------ */

export const dischargeEncounterSchema = z.object({
  ...baseSchema,
  outcome: z.enum(DISCHARGE_OUTCOMES),
  outcomeNotes: z.string().trim().max(1_000).nullable().optional(),
});

export type DischargeEncounterInput = z.input<typeof dischargeEncounterSchema>;
export interface DischargeEncounterResult {
  encounterId: string;
  status: "discharged" | "referred";
  endedAt: string;
}

export async function dischargeEncounter(
  input: DischargeEncounterInput,
  options: CommandOptions = {},
): Promise<DischargeEncounterResult> {
  const values = dischargeEncounterSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "dischargeEncounter",
    async (tx) => {
      const encounter = await loadEncounter(tx, values.facilityId, values.encounterId);
      if (encounter.status !== "open") throw new Error(CLOSED_ENCOUNTER_MESSAGE);

      const outstanding = await tx
        .select({ id: labOrders.id })
        .from(labOrders)
        .where(
          and(
            eq(labOrders.facilityId, values.facilityId),
            eq(labOrders.encounterId, encounter.id),
            inArray(labOrders.status, [...ACTIVE_LAB_ORDER_STATUSES]),
          ),
        )
        .limit(1);
      if (outstanding[0]) throw new Error(OUTSTANDING_LAB_MESSAGE);

      const now = new Date();
      await tx
        .update(encounters)
        .set({
          status: values.outcome,
          endedAt: now,
          outcome: values.outcomeNotes?.trim() || null,
          updatedAt: now,
          version: sql`${encounters.version} + 1`,
        })
        .where(
          and(eq(encounters.id, encounter.id), eq(encounters.facilityId, values.facilityId)),
        );

      await tx
        .update(queueEntries)
        .set({
          status: "done",
          doneAt: now,
          updatedAt: now,
          version: sql`${queueEntries.version} + 1`,
        })
        .where(
          and(
            eq(queueEntries.facilityId, values.facilityId),
            eq(queueEntries.encounterId, encounter.id),
            inArray(queueEntries.status, [...ACTIVE_QUEUE_STATUSES]),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: values.outcome === "referred" ? "encounter.refer" : "encounter.discharge",
        module: "doctor",
        entity: "encounters",
        entityId: encounter.id,
        details: {
          encounterNo: encounter.encounterNo,
          outcome: values.outcome,
          outcomeNotes: values.outcomeNotes ?? null,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "encounter.closed",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        outcome: values.outcome,
      });
      await publishEvent(tx, {
        type: "queue.changed",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        department: "Doctor",
        status: "done",
      });

      return {
        encounterId: encounter.id,
        status: values.outcome,
        endedAt: now.toISOString(),
      };
    },
    options,
  );
}
