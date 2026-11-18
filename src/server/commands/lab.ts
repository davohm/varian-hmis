import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { OPEN_ENCOUNTER_MESSAGE } from "@/lib/clinical";
import {
  canCollectLabOrder,
  canEnterLabResults,
  canStartLabProcessing,
  canVerifyLabResults,
  evaluateLabFlag,
  formatRefRange,
} from "@/lib/lab";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import {
  encounters,
  facilities,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { nextFormattedNumber } from "@/server/numbering";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
  labOrderId: z.uuid(),
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

interface LoadedOrder {
  id: string;
  encounterId: string;
  status: string;
  sampleId: string | null;
}

async function loadOrderForUpdate(
  tx: CommandTransaction,
  facilityId: string,
  labOrderId: string,
): Promise<LoadedOrder> {
  const rows = await tx
    .select({
      id: labOrders.id,
      encounterId: labOrders.encounterId,
      status: labOrders.status,
      sampleId: labOrders.sampleId,
    })
    .from(labOrders)
    .where(and(eq(labOrders.id, labOrderId), eq(labOrders.facilityId, facilityId)))
    .limit(1)
    .for("update");
  const order = rows[0];
  if (!order) throw new Error("Laboratory order not found in this facility");
  return order;
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

interface LoadedItem {
  id: string;
  labTestId: string;
  status: string;
  testCode: string;
  testName: string;
  parameters: Array<{
    name: string;
    unit: string;
    refLow: number | null;
    refHigh: number | null;
    criticalLow: number | null;
    criticalHigh: number | null;
  }>;
}

async function loadOrderItems(
  tx: CommandTransaction,
  facilityId: string,
  labOrderId: string,
): Promise<LoadedItem[]> {
  return tx
    .select({
      id: labOrderItems.id,
      labTestId: labOrderItems.labTestId,
      status: labOrderItems.status,
      testCode: labTests.code,
      testName: labTests.name,
      parameters: labTests.parameters,
    })
    .from(labOrderItems)
    .innerJoin(labTests, eq(labTests.id, labOrderItems.labTestId))
    .where(
      and(eq(labOrderItems.facilityId, facilityId), eq(labOrderItems.labOrderId, labOrderId)),
    )
    .orderBy(asc(labOrderItems.createdAt));
}

function assertNotCancelled(status: string): void {
  if (status === "cancelled") throw new Error("This laboratory order is cancelled");
}

/* ------------------------------------------------------------------ */
/* Sample collection                                                   */
/* ------------------------------------------------------------------ */

export const collectLabSampleSchema = z.object({
  ...baseSchema,
});

export type CollectLabSampleInput = z.input<typeof collectLabSampleSchema>;
export interface CollectLabSampleResult {
  labOrderId: string;
  sampleId: string;
  status: "collected";
  collectedAt: string;
}

export async function collectLabSample(
  input: CollectLabSampleInput,
  options: CommandOptions = {},
): Promise<CollectLabSampleResult> {
  const values = collectLabSampleSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "collectLabSample",
    async (tx) => {
      const order = await loadOrderForUpdate(tx, values.facilityId, values.labOrderId);
      assertNotCancelled(order.status);
      if (!canCollectLabOrder(order.status)) {
        throw new Error("This sample has already been collected");
      }

      const encounter = await loadOpenEncounter(tx, values.facilityId, order.encounterId);

      const facilityRows = await tx
        .select({ id: facilities.id, code: facilities.code })
        .from(facilities)
        .where(eq(facilities.id, values.facilityId))
        .limit(1);
      const facility = facilityRows[0];
      if (!facility) throw new Error("Facility not found");

      const sampleId = await nextFormattedNumber(tx, facility, "sample");
      const now = new Date();

      await tx
        .update(labOrders)
        .set({
          status: "collected",
          sampleId,
          collectedAt: now,
          updatedAt: now,
          version: sql`${labOrders.version} + 1`,
        })
        .where(and(eq(labOrders.id, order.id), eq(labOrders.facilityId, values.facilityId)));

      await tx
        .update(labOrderItems)
        .set({
          status: "collected",
          updatedAt: now,
          version: sql`${labOrderItems.version} + 1`,
        })
        .where(
          and(
            eq(labOrderItems.facilityId, values.facilityId),
            eq(labOrderItems.labOrderId, order.id),
            eq(labOrderItems.status, "ordered"),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "lab_sample.collect",
        module: "lab",
        entity: "lab_orders",
        entityId: order.id,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          patientId: encounter.patientId,
          sampleId,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "lab_sample.collected",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        labOrderId: order.id,
        sampleId,
      });

      return {
        labOrderId: order.id,
        sampleId,
        status: "collected" as const,
        collectedAt: now.toISOString(),
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Processing                                                          */
/* ------------------------------------------------------------------ */

export const startLabProcessingSchema = z.object({
  ...baseSchema,
});

export type StartLabProcessingInput = z.input<typeof startLabProcessingSchema>;
export interface StartLabProcessingResult {
  labOrderId: string;
  status: "in_progress";
}

export async function startLabProcessing(
  input: StartLabProcessingInput,
  options: CommandOptions = {},
): Promise<StartLabProcessingResult> {
  const values = startLabProcessingSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "startLabProcessing",
    async (tx) => {
      const order = await loadOrderForUpdate(tx, values.facilityId, values.labOrderId);
      assertNotCancelled(order.status);
      if (!canStartLabProcessing(order.status)) {
        throw new Error("Only a collected sample can start processing");
      }

      const encounter = await loadOpenEncounter(tx, values.facilityId, order.encounterId);
      const now = new Date();

      await tx
        .update(labOrders)
        .set({
          status: "in_progress",
          updatedAt: now,
          version: sql`${labOrders.version} + 1`,
        })
        .where(and(eq(labOrders.id, order.id), eq(labOrders.facilityId, values.facilityId)));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "lab_processing.start",
        module: "lab",
        entity: "lab_orders",
        entityId: order.id,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          patientId: encounter.patientId,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "lab_processing.started",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        labOrderId: order.id,
      });

      return { labOrderId: order.id, status: "in_progress" as const };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Result entry                                                        */
/* ------------------------------------------------------------------ */

const resultEntrySchema = z.object({
  labOrderItemId: z.uuid(),
  parameter: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(500),
});

export const enterLabResultsSchema = z.object({
  ...baseSchema,
  results: z.array(resultEntrySchema).min(1).max(200),
});

export type EnterLabResultsInput = z.input<typeof enterLabResultsSchema>;
export interface EnterLabResultsItem {
  itemId: string;
  status: string;
  complete: boolean;
}
export interface EnterLabResultsResult {
  labOrderId: string;
  status: string;
  entered: number;
  items: EnterLabResultsItem[];
}

export async function enterLabResults(
  input: EnterLabResultsInput,
  options: CommandOptions = {},
): Promise<EnterLabResultsResult> {
  const values = enterLabResultsSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "enterLabResults",
    async (tx) => {
      const order = await loadOrderForUpdate(tx, values.facilityId, values.labOrderId);
      assertNotCancelled(order.status);
      if (order.status === "verified") {
        throw new Error("Verified results are locked and cannot be edited");
      }
      if (!canEnterLabResults(order.status)) {
        throw new Error("Collect the sample before entering results");
      }

      const encounter = await loadOpenEncounter(tx, values.facilityId, order.encounterId);
      const items = await loadOrderItems(tx, values.facilityId, order.id);
      if (items.length === 0) throw new Error("This laboratory order has no tests");

      const itemsById = new Map(items.map((item) => [item.id, item]));
      const seen = new Set<string>();
      for (const entry of values.results) {
        const key = `${entry.labOrderItemId}:${entry.parameter}`;
        if (seen.has(key)) {
          throw new Error("The same parameter was submitted more than once");
        }
        seen.add(key);

        const item = itemsById.get(entry.labOrderItemId);
        if (!item) {
          throw new Error("A submitted result does not belong to this laboratory order");
        }
        if (!item.parameters.some((parameter) => parameter.name === entry.parameter)) {
          throw new Error(`${entry.parameter} is not a parameter of ${item.testName}`);
        }
      }

      const itemIds = items.map((item) => item.id);
      const existingRows = await tx
        .select()
        .from(labResults)
        .where(
          and(
            eq(labResults.facilityId, values.facilityId),
            inArray(labResults.labOrderItemId, itemIds),
          ),
        )
        .for("update");
      const existingByKey = new Map(
        existingRows.map((row) => [`${row.labOrderItemId}:${row.parameter}`, row]),
      );

      const now = new Date();
      for (const entry of values.results) {
        const item = itemsById.get(entry.labOrderItemId) as LoadedItem;
        const definition = item.parameters.find(
          (parameter) => parameter.name === entry.parameter,
        );
        if (!definition) throw new Error(`${entry.parameter} is not a valid parameter`);

        const key = `${entry.labOrderItemId}:${entry.parameter}`;
        const existing = existingByKey.get(key);
        if (existing?.verifiedAt) {
          throw new Error("Verified results are locked and cannot be edited");
        }

        const flag = evaluateLabFlag(entry.value, definition);
        const refRange = formatRefRange(definition);
        const unit = definition.unit || null;

        if (existing) {
          await tx
            .update(labResults)
            .set({
              value: entry.value,
              unit,
              refRange,
              flag,
              enteredBy: userId,
              updatedAt: now,
              version: sql`${labResults.version} + 1`,
            })
            .where(
              and(
                eq(labResults.id, existing.id),
                eq(labResults.facilityId, values.facilityId),
              ),
            );
        } else {
          await tx.insert(labResults).values({
            id: newId(),
            facilityId: values.facilityId,
            labOrderItemId: entry.labOrderItemId,
            parameter: definition.name,
            value: entry.value,
            unit,
            refRange,
            flag,
            enteredBy: userId,
            createdBy: userId,
          });
        }
      }

      const resultRows = await tx
        .select({
          labOrderItemId: labResults.labOrderItemId,
          parameter: labResults.parameter,
          value: labResults.value,
        })
        .from(labResults)
        .where(
          and(
            eq(labResults.facilityId, values.facilityId),
            inArray(labResults.labOrderItemId, itemIds),
          ),
        );
      const completed = new Set(
        resultRows
          .filter((row) => row.value.trim() !== "")
          .map((row) => `${row.labOrderItemId}:${row.parameter}`),
      );

      const itemResults: EnterLabResultsItem[] = [];
      for (const item of items) {
        const complete =
          item.parameters.length > 0 &&
          item.parameters.every((parameter) =>
            completed.has(`${item.id}:${parameter.name}`),
          );
        const status = complete ? "resulted" : item.status;

        if (status !== item.status) {
          await tx
            .update(labOrderItems)
            .set({
              status: "resulted",
              updatedAt: now,
              version: sql`${labOrderItems.version} + 1`,
            })
            .where(
              and(
                eq(labOrderItems.id, item.id),
                eq(labOrderItems.facilityId, values.facilityId),
              ),
            );
        }

        itemResults.push({ itemId: item.id, status, complete });
      }

      const allComplete = itemResults.every((item) => item.complete);
      const status = allComplete ? "resulted" : "in_progress";

      await tx
        .update(labOrders)
        .set({
          status,
          updatedAt: now,
          version: sql`${labOrders.version} + 1`,
        })
        .where(and(eq(labOrders.id, order.id), eq(labOrders.facilityId, values.facilityId)));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "lab_results.enter",
        module: "lab",
        entity: "lab_orders",
        entityId: order.id,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          patientId: encounter.patientId,
          entered: values.results.length,
          status,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "lab_results.entered",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        labOrderId: order.id,
        status,
        itemIds,
      });

      return {
        labOrderId: order.id,
        status,
        entered: values.results.length,
        items: itemResults,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export const verifyLabResultsSchema = z.object({
  ...baseSchema,
});

export type VerifyLabResultsInput = z.input<typeof verifyLabResultsSchema>;
export interface VerifyLabResultsResult {
  labOrderId: string;
  status: "verified";
  verifiedAt: string;
}

export async function verifyLabResults(
  input: VerifyLabResultsInput,
  options: CommandOptions = {},
): Promise<VerifyLabResultsResult> {
  const values = verifyLabResultsSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "verifyLabResults",
    async (tx) => {
      const order = await loadOrderForUpdate(tx, values.facilityId, values.labOrderId);
      assertNotCancelled(order.status);
      if (order.status === "verified") {
        throw new Error("This laboratory order is already verified");
      }
      if (!canVerifyLabResults(order.status)) {
        throw new Error("Only a complete, resulted order can be verified");
      }

      const encounter = await loadEncounter(tx, values.facilityId, order.encounterId);
      const items = await loadOrderItems(tx, values.facilityId, order.id);
      if (items.length === 0) throw new Error("This laboratory order has no tests");

      const itemIds = items.map((item) => item.id);
      const resultRows = await tx
        .select({
          id: labResults.id,
          labOrderItemId: labResults.labOrderItemId,
          parameter: labResults.parameter,
          value: labResults.value,
          verifiedAt: labResults.verifiedAt,
        })
        .from(labResults)
        .where(
          and(
            eq(labResults.facilityId, values.facilityId),
            inArray(labResults.labOrderItemId, itemIds),
          ),
        )
        .for("update");

      const completed = new Set(
        resultRows
          .filter((row) => row.value.trim() !== "")
          .map((row) => `${row.labOrderItemId}:${row.parameter}`),
      );
      for (const item of items) {
        if (item.parameters.length === 0) {
          throw new Error(`${item.testName} has no parameters to verify`);
        }
        const missing = item.parameters.filter(
          (parameter) => !completed.has(`${item.id}:${parameter.name}`),
        );
        if (missing.length > 0) {
          throw new Error(
            `${item.testName} is missing ${missing.map((parameter) => parameter.name).join(", ")}`,
          );
        }
      }

      const now = new Date();
      await tx
        .update(labResults)
        .set({
          verifiedBy: userId,
          verifiedAt: now,
          updatedAt: now,
          version: sql`${labResults.version} + 1`,
        })
        .where(
          and(
            eq(labResults.facilityId, values.facilityId),
            inArray(labResults.labOrderItemId, itemIds),
          ),
        );

      await tx
        .update(labOrderItems)
        .set({
          status: "verified",
          updatedAt: now,
          version: sql`${labOrderItems.version} + 1`,
        })
        .where(
          and(
            eq(labOrderItems.facilityId, values.facilityId),
            eq(labOrderItems.labOrderId, order.id),
          ),
        );

      await tx
        .update(labOrders)
        .set({
          status: "verified",
          updatedAt: now,
          version: sql`${labOrders.version} + 1`,
        })
        .where(and(eq(labOrders.id, order.id), eq(labOrders.facilityId, values.facilityId)));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "lab_results.verify",
        module: "lab",
        entity: "lab_orders",
        entityId: order.id,
        details: {
          encounterId: encounter.id,
          encounterNo: encounter.encounterNo,
          patientId: encounter.patientId,
          results: resultRows.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "lab_results.verified",
        facilityId: values.facilityId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        labOrderId: order.id,
      });

      return {
        labOrderId: order.id,
        status: "verified" as const,
        verifiedAt: now.toISOString(),
      };
    },
    options,
  );
}
