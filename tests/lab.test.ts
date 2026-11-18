import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OPEN_ENCOUNTER_MESSAGE,
  OUTSTANDING_LAB_MESSAGE,
} from "../src/lib/clinical";
import {
  canCollectLabOrder,
  canEnterLabResults,
  canStartLabProcessing,
  canVerifyLabResults,
  evaluateLabFlag,
  formatRefRange,
  isCriticalLabFlag,
  isNumericParameter,
  labStatusesForFilter,
  slugifyParameter,
} from "../src/lib/lab";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  cancelLabOrder,
  dischargeEncounter,
  orderLabTests,
} from "../src/server/commands/clinical";
import {
  collectLabSample,
  enterLabResults,
  startLabProcessing,
  verifyLabResults,
} from "../src/server/commands/lab";
import { startVisit } from "../src/server/commands/encounters";
import { registerPatient, type RegisterPatientInput } from "../src/server/commands/patients";
import { queuePatient } from "../src/server/commands/queue";
import { recordTriageVitals } from "../src/server/commands/triage";
import {
  auditLog,
  encounters,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
} from "../src/server/db/schema";
import type { LabParameter } from "../src/server/db/schema/clinical";
import { createEventSubscription, type DomainEvent } from "../src/server/events";
import { getEncounterClinicalDetail } from "../src/server/queries/clinical";
import { getLabWorklist } from "../src/server/queries/lab";

import {
  cleanupTestFacility,
  createTestDatabase,
  insertTestBranch,
  insertTestFacility,
  type TestDatabase,
} from "./helpers";

let ctx: TestDatabase;

beforeAll(() => {
  ctx = createTestDatabase();
});

afterAll(async () => {
  await ctx.pool.end();
});

const ACTOR = { userId: "vitest" };

const HAEMOGLOBIN: LabParameter = {
  name: "Haemoglobin",
  unit: "g/dL",
  refLow: 12,
  refHigh: 17,
  criticalLow: 7,
  criticalHigh: 20,
};

const TEXT_PARAMETER: LabParameter = {
  name: "Blood film comment",
  unit: "",
  refLow: null,
  refHigh: null,
  criticalLow: null,
  criticalHigh: null,
};

const FBC_PARAMETERS: LabParameter[] = [
  HAEMOGLOBIN,
  {
    name: "White cell count",
    unit: "10^9/L",
    refLow: 4,
    refHigh: 11,
    criticalLow: 2,
    criticalHigh: 20,
  },
  {
    name: "Platelets",
    unit: "10^9/L",
    refLow: 150,
    refHigh: 450,
    criticalLow: 50,
    criticalHigh: 1_000,
  },
];

interface LabFixture {
  facility: { id: string; code: string };
  branchId: string;
  fbc: { id: string; code: string; name: string };
  film: { id: string; code: string; name: string };
}

/**
 * A facility with its own laboratory catalogue so every rule can be exercised
 * without depending on seed data. Cleanup removes the catalogue and the
 * `number_sequences` row that sample numbering creates.
 */
async function withLabFacility<T>(run: (fixture: LabFixture) => Promise<T>): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

  const fbc = {
    id: newId(),
    code: `FBC${suffix}`,
    name: `Full Blood Count ${suffix}`,
  };
  const film = {
    id: newId(),
    code: `FILM${suffix}`,
    name: `Blood Film ${suffix}`,
  };

  await ctx.db.insert(labTests).values([
    {
      id: fbc.id,
      facilityId: facility.id,
      code: fbc.code,
      name: fbc.name,
      sampleType: "Whole blood (EDTA)",
      parameters: FBC_PARAMETERS,
      createdBy: "vitest",
    },
    {
      id: film.id,
      facilityId: facility.id,
      code: film.code,
      name: film.name,
      sampleType: "Whole blood (EDTA)",
      parameters: [TEXT_PARAMETER],
      createdBy: "vitest",
    },
  ]);

  try {
    return await run({ facility, branchId, fbc, film });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

function patientInput(
  facilityId: string,
  overrides: Partial<RegisterPatientInput> = {},
): RegisterPatientInput {
  return {
    facilityId,
    idempotencyKey: newIdempotencyKey(),
    firstName: "Amina",
    lastName: "Otieno",
    dob: "1990-04-12",
    sex: "female",
    phone: "0712345678",
    nationalId: `ID-${newId().slice(0, 8)}`,
    allergies: ["Penicillin"],
    bloodGroup: "O+",
    actor: ACTOR,
    ...overrides,
  };
}

interface LabVisit {
  patientId: string;
  mrn: string;
  encounterId: string;
  encounterNo: string;
  doctorQueueEntryId: string;
}

/** Register, start a visit, triage it and hand the patient to the doctor. */
async function createLabVisit(
  fixture: LabFixture,
  overrides: Partial<RegisterPatientInput> = {},
): Promise<LabVisit> {
  const registered = await registerPatient(patientInput(fixture.facility.id, overrides), {
    database: ctx.db,
  });
  const visit = await startVisit(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      patientId: registered.patientId,
      branchId: fixture.branchId,
      actor: ACTOR,
    },
    { database: ctx.db },
  );
  const triage = await queuePatient(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      encounterId: visit.encounterId,
      department: "Triage",
      actor: ACTOR,
    },
    { database: ctx.db },
  );
  const vitals = await recordTriageVitals(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      queueEntryId: triage.queueEntryId,
      systolic: 118,
      diastolic: 76,
      heartRate: 72,
      respRate: 16,
      temperature: 36.8,
      spo2: 98,
      weightKg: 64,
      heightCm: 165,
      painScore: 1,
      category: "green",
      chiefComplaint: "Headache for two days",
      comments: "No red flags",
      nextSteps: "Doctor review",
    },
    { database: ctx.db },
  );

  return {
    patientId: registered.patientId,
    mrn: registered.mrn,
    encounterId: visit.encounterId,
    encounterNo: visit.encounterNo,
    doctorQueueEntryId: vitals.doctorQueueEntryId,
  };
}

async function orderTests(
  fixture: LabFixture,
  visit: LabVisit,
  labTestIds: string[],
  clinicalNotes: string | null = null,
) {
  return orderLabTests(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      labTestIds,
      clinicalNotes,
    },
    { database: ctx.db },
  );
}

async function itemRows(labOrderId: string) {
  return ctx.db
    .select()
    .from(labOrderItems)
    .where(eq(labOrderItems.labOrderId, labOrderId));
}

async function resultRows(labOrderId: string) {
  const items = await itemRows(labOrderId);
  const ids = items.map((item) => item.id);
  if (ids.length === 0) return [];
  return ctx.db.select().from(labResults).where(inArray(labResults.labOrderItemId, ids));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function collectInput(fixture: LabFixture, labOrderId: string, key = newIdempotencyKey()) {
  return {
    facilityId: fixture.facility.id,
    idempotencyKey: key,
    actor: ACTOR,
    labOrderId,
  };
}

describe("laboratory flag rules", () => {
  it("flags normal, abnormal and critical values against inclusive bounds", () => {
    expect(evaluateLabFlag("14", HAEMOGLOBIN)).toBe("N");
    expect(evaluateLabFlag("12", HAEMOGLOBIN)).toBe("N");
    expect(evaluateLabFlag("17", HAEMOGLOBIN)).toBe("N");
    expect(evaluateLabFlag("17.1", HAEMOGLOBIN)).toBe("H");
    expect(evaluateLabFlag("11.9", HAEMOGLOBIN)).toBe("L");
    expect(evaluateLabFlag("20", HAEMOGLOBIN)).toBe("HH");
    expect(evaluateLabFlag("21.4", HAEMOGLOBIN)).toBe("HH");
    expect(evaluateLabFlag("7", HAEMOGLOBIN)).toBe("LL");
    expect(evaluateLabFlag("6.9", HAEMOGLOBIN)).toBe("LL");
  });

  it("treats a parameter without numeric bounds as free text and never flags it", () => {
    expect(isNumericParameter(TEXT_PARAMETER)).toBe(false);
    expect(isNumericParameter(HAEMOGLOBIN)).toBe(true);
    expect(evaluateLabFlag("Sickle cells seen", TEXT_PARAMETER)).toBe("N");
  });

  it("rejects a non-numeric value on a numeric parameter and a blank value anywhere", () => {
    expect(() => evaluateLabFlag("low", HAEMOGLOBIN)).toThrow(/numeric/);
    expect(() => evaluateLabFlag("  ", HAEMOGLOBIN)).toThrow(/required/);
    expect(() => evaluateLabFlag("", TEXT_PARAMETER)).toThrow(/required/);
  });

  it("formats reference ranges for display", () => {
    expect(formatRefRange(HAEMOGLOBIN)).toBe("12 - 17");
    expect(
      formatRefRange({ ...TEXT_PARAMETER, name: "Upper bound only", refLow: null, refHigh: 0 }),
    ).toBe("<= 0");
    expect(
      formatRefRange({ ...TEXT_PARAMETER, name: "Lower bound only", refLow: 3.9, refHigh: null }),
    ).toBe(">= 3.9");
    expect(formatRefRange(TEXT_PARAMETER)).toBeNull();
  });

  it("builds stable slugs for parameter inputs", () => {
    expect(slugifyParameter("White cell count")).toBe("white-cell-count");
    expect(slugifyParameter("MCV")).toBe("mcv");
    expect(slugifyParameter("  ")).toBe("parameter");
  });

  it("guards every status transition", () => {
    expect(canCollectLabOrder("ordered")).toBe(true);
    expect(canCollectLabOrder("collected")).toBe(false);
    expect(canCollectLabOrder("cancelled")).toBe(false);

    expect(canStartLabProcessing("collected")).toBe(true);
    expect(canStartLabProcessing("ordered")).toBe(false);
    expect(canStartLabProcessing("in_progress")).toBe(false);

    expect(canEnterLabResults("collected")).toBe(true);
    expect(canEnterLabResults("in_progress")).toBe(true);
    expect(canEnterLabResults("resulted")).toBe(true);
    expect(canEnterLabResults("verified")).toBe(false);
    expect(canEnterLabResults("cancelled")).toBe(false);

    expect(canVerifyLabResults("resulted")).toBe(true);
    expect(canVerifyLabResults("in_progress")).toBe(false);
    expect(canVerifyLabResults("verified")).toBe(false);

    expect(isCriticalLabFlag("HH")).toBe(true);
    expect(isCriticalLabFlag("LL")).toBe(true);
    expect(isCriticalLabFlag("H")).toBe(false);
    expect(isCriticalLabFlag(null)).toBe(false);
  });

  it("maps worklist filters to status groups", () => {
    expect(labStatusesForFilter("pending")).toEqual([
      "ordered",
      "collected",
      "in_progress",
      "resulted",
    ]);
    expect(labStatusesForFilter("verified")).toEqual(["verified"]);
    expect(labStatusesForFilter("cancelled")).toEqual(["cancelled"]);
    expect(labStatusesForFilter("all")).toBeNull();
  });
});

describe("collectLabSample", () => {
  it("allocates a sample id, moves the order and items to collected and audits it", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);

      const result = await collectLabSample(collectInput(fixture, order.labOrderId), {
        database: ctx.db,
      });
      expect(result.status).toBe("collected");
      expect(result.labOrderId).toBe(order.labOrderId);
      expect(result.sampleId).toMatch(
        new RegExp(`^${fixture.facility.code}-S-\\d{2}-\\d{6}$`),
      );
      expect(result.collectedAt).toBeTruthy();

      const orders = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, order.labOrderId));
      expect(orders[0]).toMatchObject({
        status: "collected",
        sampleId: result.sampleId,
      });
      expect(orders[0].collectedAt).not.toBeNull();

      const items = await itemRows(order.labOrderId);
      expect(items.map((item) => item.status)).toEqual(["collected"]);

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, order.labOrderId));
      expect(audits.filter((row) => row.action === "lab_sample.collect")).toHaveLength(1);
    });
  });

  it("replays an idempotent collection without allocating a second sample", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      const input = collectInput(fixture, order.labOrderId);

      const first = await collectLabSample(input, { database: ctx.db });
      const replay = await collectLabSample(input, { database: ctx.db });
      expect(replay).toEqual(first);

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, order.labOrderId));
      expect(audits.filter((row) => row.action === "lab_sample.collect")).toHaveLength(1);
    });
  });

  it("rejects a second collection and a cancelled order", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });

      await expect(
        collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db }),
      ).rejects.toThrow(/already been collected/);

      const cancelledOrder = await orderTests(fixture, visit, [fixture.fbc.id]);
      await cancelLabOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labOrderId: cancelledOrder.labOrderId,
        },
        { database: ctx.db },
      );

      await expect(
        collectLabSample(collectInput(fixture, cancelledOrder.labOrderId), {
          database: ctx.db,
        }),
      ).rejects.toThrow(/cancelled/);
    });
  });

  it("refuses to collect for a closed visit", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await ctx.db.execute(
        sql`UPDATE encounters SET status = 'discharged' WHERE id = ${visit.encounterId}::uuid`,
      );

      await expect(
        collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db }),
      ).rejects.toThrow(OPEN_ENCOUNTER_MESSAGE);
    });
  });

  it("publishes a collection event for the encounter", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();
      try {
        await collectLabSample(collectInput(fixture, order.labOrderId), {
          database: ctx.db,
        });
        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "lab_sample.collected" &&
              event.encounterId === visit.encounterId,
          ),
        );
        const event = events.find(
          (row) => row.type === "lab_sample.collected" && row.encounterId === visit.encounterId,
        );
        expect(event?.labOrderId).toBe(order.labOrderId);
      } finally {
        await subscription.close();
      }
    });
  });
});

describe("startLabProcessing", () => {
  it("moves a collected sample to in progress", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });

      const result = await startLabProcessing(collectInput(fixture, order.labOrderId), {
        database: ctx.db,
      });
      expect(result).toEqual({ labOrderId: order.labOrderId, status: "in_progress" });

      const orders = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, order.labOrderId));
      expect(orders[0].status).toBe("in_progress");

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, order.labOrderId));
      expect(audits.filter((row) => row.action === "lab_processing.start")).toHaveLength(1);
    });
  });

  it("requires a collected sample", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);

      await expect(
        startLabProcessing(collectInput(fixture, order.labOrderId), { database: ctx.db }),
      ).rejects.toThrow(/Only a collected sample/);
    });
  });
});

describe("enterLabResults", () => {
  it("saves partial results, auto-flags them and completes the order when every parameter is in", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);

      const partial = await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [{ labOrderItemId: item.id, parameter: "Haemoglobin", value: "18.2" }],
        },
        { database: ctx.db },
      );
      expect(partial.status).toBe("in_progress");
      expect(partial.entered).toBe(1);
      expect(partial.items).toEqual([{ itemId: item.id, status: "collected", complete: false }]);

      let rows = await resultRows(order.labOrderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        parameter: "Haemoglobin",
        value: "18.2",
        unit: "g/dL",
        refRange: "12 - 17",
        flag: "H",
        enteredBy: "vitest",
        verifiedAt: null,
      });

      const orders = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, order.labOrderId));
      expect(orders[0].status).toBe("in_progress");
      expect((await itemRows(order.labOrderId))[0].status).toBe("collected");

      const complete = await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [
            { labOrderItemId: item.id, parameter: "White cell count", value: "6.4" },
            { labOrderItemId: item.id, parameter: "Platelets", value: "40" },
          ],
        },
        { database: ctx.db },
      );
      expect(complete.status).toBe("resulted");
      expect(complete.items).toEqual([{ itemId: item.id, status: "resulted", complete: true }]);

      rows = await resultRows(order.labOrderId);
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.parameter === "Platelets")?.flag).toBe("LL");
      expect(rows.find((row) => row.parameter === "White cell count")?.flag).toBe("N");

      const resultedOrder = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, order.labOrderId));
      expect(resultedOrder[0].status).toBe("resulted");
      expect((await itemRows(order.labOrderId))[0].status).toBe("resulted");
    });
  });

  it("allows corrections until verification and flags free-text parameters as normal", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.film.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);

      const first = await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [
            { labOrderItemId: item.id, parameter: "Blood film comment", value: "Normocytic" },
          ],
        },
        { database: ctx.db },
      );
      expect(first.status).toBe("resulted");

      const original = (await resultRows(order.labOrderId))[0];
      expect(original.flag).toBe("N");

      const correction = await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [
            {
              labOrderItemId: item.id,
              parameter: "Blood film comment",
              value: "Microcytic hypochromic",
            },
          ],
        },
        { database: ctx.db },
      );
      expect(correction.status).toBe("resulted");

      const corrected = await resultRows(order.labOrderId);
      expect(corrected).toHaveLength(1);
      expect(corrected[0]).toMatchObject({
        id: original.id,
        value: "Microcytic hypochromic",
        flag: "N",
      });
      expect(corrected[0].version).toBe(original.version + 1);
    });
  });

  it("rejects non-numeric values, unknown parameters, duplicate entries and foreign items", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);

      const base = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        labOrderId: order.labOrderId,
      };

      await expect(
        enterLabResults(
          {
            ...base,
            results: [{ labOrderItemId: item.id, parameter: "Haemoglobin", value: "very low" }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/numeric/);

      await expect(
        enterLabResults(
          {
            ...base,
            results: [{ labOrderItemId: item.id, parameter: "Creatinine", value: "80" }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/not a parameter/);

      await expect(
        enterLabResults(
          {
            ...base,
            results: [
              { labOrderItemId: item.id, parameter: "Haemoglobin", value: "14" },
              { labOrderItemId: item.id, parameter: "Haemoglobin", value: "15" },
            ],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/more than once/);

      const otherOrder = await orderTests(fixture, visit, [fixture.film.id]);
      const [otherItem] = await itemRows(otherOrder.labOrderId);

      await expect(
        enterLabResults(
          {
            ...base,
            results: [
              { labOrderItemId: otherItem.id, parameter: "Blood film comment", value: "Normal" },
            ],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/does not belong/);

      expect(await resultRows(order.labOrderId)).toHaveLength(0);
    });
  });

  it("refuses results before collection, for a cancelled order and on a closed visit", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      const [item] = await itemRows(order.labOrderId);
      const entry = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        labOrderId: order.labOrderId,
        results: [{ labOrderItemId: item.id, parameter: "Haemoglobin", value: "14" }],
      };

      await expect(enterLabResults(entry, { database: ctx.db })).rejects.toThrow(
        /Collect the sample/,
      );

      const cancelledOrder = await orderTests(fixture, visit, [fixture.fbc.id]);
      const [cancelledItem] = await itemRows(cancelledOrder.labOrderId);
      await cancelLabOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labOrderId: cancelledOrder.labOrderId,
        },
        { database: ctx.db },
      );

      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      await ctx.db.execute(
        sql`UPDATE encounters SET status = 'discharged' WHERE id = ${visit.encounterId}::uuid`,
      );
      await expect(enterLabResults(entry, { database: ctx.db })).rejects.toThrow(
        OPEN_ENCOUNTER_MESSAGE,
      );

      await expect(
        enterLabResults(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            labOrderId: cancelledOrder.labOrderId,
            results: [
              { labOrderItemId: cancelledItem.id, parameter: "Haemoglobin", value: "14" },
            ],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/cancelled/);
    });
  });

  it("publishes a result event carrying the resulting order status", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.film.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);

      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();
      try {
        await enterLabResults(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            labOrderId: order.labOrderId,
            results: [
              { labOrderItemId: item.id, parameter: "Blood film comment", value: "Normal" },
            ],
          },
          { database: ctx.db },
        );
        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "lab_results.entered" &&
              event.encounterId === visit.encounterId,
          ),
        );
        const event = events.find(
          (row) => row.type === "lab_results.entered" && row.encounterId === visit.encounterId,
        );
        expect(event?.status).toBe("resulted");
      } finally {
        await subscription.close();
      }
    });
  });
});

describe("verifyLabResults", () => {
  it("verifies a complete order, records the verifier and locks the results", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);

      await expect(
        verifyLabResults(collectInput(fixture, order.labOrderId), { database: ctx.db }),
      ).rejects.toThrow(/complete, resulted/);

      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: FBC_PARAMETERS.map((parameter) => ({
            labOrderItemId: item.id,
            parameter: parameter.name,
            value: parameter.name === "Platelets" ? "250" : "14",
          })),
        },
        { database: ctx.db },
      );

      const verified = await verifyLabResults(collectInput(fixture, order.labOrderId), {
        database: ctx.db,
      });
      expect(verified.status).toBe("verified");
      expect(verified.verifiedAt).toBeTruthy();

      const rows = await resultRows(order.labOrderId);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.verifiedAt !== null)).toBe(true);
      expect(rows.every((row) => row.verifiedBy === "vitest")).toBe(true);

      const orders = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, order.labOrderId));
      expect(orders[0].status).toBe("verified");
      expect((await itemRows(order.labOrderId))[0].status).toBe("verified");

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, order.labOrderId));
      expect(audits.filter((row) => row.action === "lab_results.verify")).toHaveLength(1);

      await expect(
        verifyLabResults(collectInput(fixture, order.labOrderId), { database: ctx.db }),
      ).rejects.toThrow(/already verified/);

      await expect(
        enterLabResults(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            labOrderId: order.labOrderId,
            results: [{ labOrderItemId: item.id, parameter: "Haemoglobin", value: "15" }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/locked/);
    });
  });

  it("refuses to verify an order with missing parameters", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);
      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [{ labOrderItemId: item.id, parameter: "Haemoglobin", value: "14" }],
        },
        { database: ctx.db },
      );

      // Test-only fixture: force the order past result entry to prove verification
      // still re-checks completeness rather than trusting the status.
      await ctx.db.execute(
        sql`UPDATE lab_orders SET status = 'resulted' WHERE id = ${order.labOrderId}::uuid`,
      );

      await expect(
        verifyLabResults(collectInput(fixture, order.labOrderId), { database: ctx.db }),
      ).rejects.toThrow(/missing White cell count, Platelets/);
    });
  });

  it("verifies after the visit has closed, because verification is not a clinical write", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.film.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);
      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [
            { labOrderItemId: item.id, parameter: "Blood film comment", value: "Normal" },
          ],
        },
        { database: ctx.db },
      );
      await ctx.db.execute(
        sql`UPDATE encounters SET status = 'discharged' WHERE id = ${visit.encounterId}::uuid`,
      );

      const verified = await verifyLabResults(collectInput(fixture, order.labOrderId), {
        database: ctx.db,
      });
      expect(verified.status).toBe("verified");
    });
  });

  it("publishes a verification event and releases results to the doctor", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.fbc.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);
      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: FBC_PARAMETERS.map((parameter) => ({
            labOrderItemId: item.id,
            parameter: parameter.name,
            value: parameter.name === "Platelets" ? "250" : "14",
          })),
        },
        { database: ctx.db },
      );

      const before = await getEncounterClinicalDetail(
        ctx.db,
        fixture.facility.id,
        visit.encounterId,
      );
      const beforeOrder = before?.labOrders.find((row) => row.id === order.labOrderId);
      expect(beforeOrder?.items[0].results).toHaveLength(0);

      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();
      try {
        await verifyLabResults(collectInput(fixture, order.labOrderId), {
          database: ctx.db,
        });
        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "lab_results.verified" &&
              event.encounterId === visit.encounterId,
          ),
        );
      } finally {
        await subscription.close();
      }

      const after = await getEncounterClinicalDetail(
        ctx.db,
        fixture.facility.id,
        visit.encounterId,
      );
      const afterOrder = after?.labOrders.find((row) => row.id === order.labOrderId);
      expect(afterOrder?.status).toBe("verified");
      expect(afterOrder?.items[0].results).toHaveLength(3);
      expect(afterOrder?.items[0].results[0]).toMatchObject({
        verifiedBy: "vitest",
      });
      expect(afterOrder?.items[0].results[0].verifiedAt).toBeTruthy();
    });
  });
});

describe("laboratory orders and the visit lifecycle", () => {
  it("blocks discharge while a result awaits verification, then allows it", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.film.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);
      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [
            { labOrderItemId: item.id, parameter: "Blood film comment", value: "Normal" },
          ],
        },
        { database: ctx.db },
      );

      const discharge = () =>
        dischargeEncounter(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            outcome: "discharged",
          },
          { database: ctx.db },
        );

      await expect(discharge()).rejects.toThrow(OUTSTANDING_LAB_MESSAGE);

      await verifyLabResults(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const closed = await discharge();
      expect(closed.status).toBe("discharged");

      const rows = await ctx.db
        .select()
        .from(encounters)
        .where(eq(encounters.id, visit.encounterId));
      expect(rows[0].status).toBe("discharged");
    });
  });
});

describe("getLabWorklist", () => {
  it("groups by status, exposes the patient banner and includes entered results", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture, {
        firstName: "Wanjiku",
        lastName: "Kamau",
      });
      const order = await orderTests(
        fixture,
        visit,
        [fixture.fbc.id],
        "Rule out anaemia",
      );

      const pending = await getLabWorklist(ctx.db, fixture.facility.id, "pending");
      expect(pending.map((row) => row.id)).toEqual([order.labOrderId]);
      expect(pending[0]).toMatchObject({
        mrn: visit.mrn,
        firstName: "Wanjiku",
        lastName: "Kamau",
        sex: "female",
        payerType: "cash",
        clinicalNotes: "Rule out anaemia",
        status: "ordered",
      });
      expect(pending[0].allergies).toEqual(["Penicillin"]);
      expect(pending[0].items).toHaveLength(1);
      expect(pending[0].items[0].parameters).toHaveLength(3);
      expect(pending[0].items[0].results).toHaveLength(0);

      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const collected = await getLabWorklist(ctx.db, fixture.facility.id, "pending");
      expect(collected[0].status).toBe("collected");
      expect(collected[0].sampleId).toMatch(/^.+S-\d{2}-\d{6}$/);
      expect(collected[0].collectedAt).toBeTruthy();

      const [item] = await itemRows(order.labOrderId);
      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [{ labOrderItemId: item.id, parameter: "Haemoglobin", value: "18" }],
        },
        { database: ctx.db },
      );

      const inProgress = await getLabWorklist(ctx.db, fixture.facility.id, "pending");
      expect(inProgress[0].status).toBe("in_progress");
      expect(inProgress[0].items[0].results).toHaveLength(1);
      expect(inProgress[0].items[0].results[0]).toMatchObject({
        parameter: "Haemoglobin",
        value: "18",
        flag: "H",
        verifiedAt: null,
      });

      const verified = await getLabWorklist(ctx.db, fixture.facility.id, "verified");
      expect(verified).toHaveLength(0);
    });
  });

  it("searches by MRN, patient name, visit number and sample id", async () => {
    await withLabFacility(async (fixture) => {
      const first = await createLabVisit(fixture, {
        firstName: "Wanjiku",
        lastName: "Kamau",
      });
      const second = await createLabVisit(fixture, {
        firstName: "Brian",
        lastName: "Ochieng",
      });
      const firstOrder = await orderTests(fixture, first, [fixture.fbc.id]);
      await orderTests(fixture, second, [fixture.fbc.id]);

      const byMrn = await getLabWorklist(ctx.db, fixture.facility.id, "pending", first.mrn);
      expect(byMrn.map((row) => row.id)).toEqual([firstOrder.labOrderId]);

      const byName = await getLabWorklist(ctx.db, fixture.facility.id, "pending", "ochieng");
      expect(byName).toHaveLength(1);
      expect(byName[0].firstName).toBe("Brian");

      const byVisit = await getLabWorklist(
        ctx.db,
        fixture.facility.id,
        "pending",
        second.encounterNo,
      );
      expect(byVisit).toHaveLength(1);
      expect(byVisit[0].encounterId).toBe(second.encounterId);

      const collected = await collectLabSample(collectInput(fixture, firstOrder.labOrderId), {
        database: ctx.db,
      });
      const bySample = await getLabWorklist(
        ctx.db,
        fixture.facility.id,
        "pending",
        collected.sampleId,
      );
      expect(bySample.map((row) => row.id)).toEqual([firstOrder.labOrderId]);

      const noMatch = await getLabWorklist(ctx.db, fixture.facility.id, "pending", "ZZZ-000");
      expect(noMatch).toHaveLength(0);
    });
  });

  it("keeps facilities isolated and lists verified orders separately", async () => {
    await withLabFacility(async (fixture) => {
      const visit = await createLabVisit(fixture);
      const order = await orderTests(fixture, visit, [fixture.film.id]);
      await collectLabSample(collectInput(fixture, order.labOrderId), { database: ctx.db });
      const [item] = await itemRows(order.labOrderId);
      await enterLabResults(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          labOrderId: order.labOrderId,
          results: [
            { labOrderItemId: item.id, parameter: "Blood film comment", value: "Normal" },
          ],
        },
        { database: ctx.db },
      );
      await verifyLabResults(collectInput(fixture, order.labOrderId), { database: ctx.db });

      expect(await getLabWorklist(ctx.db, fixture.facility.id, "pending")).toHaveLength(0);
      const verified = await getLabWorklist(ctx.db, fixture.facility.id, "verified");
      expect(verified.map((row) => row.id)).toEqual([order.labOrderId]);
      expect(verified[0].items[0].results[0].verifiedBy).toBe("vitest");

      await withLabFacility(async (other) => {
        const otherVisit = await createLabVisit(other);
        const otherOrder = await orderTests(other, otherVisit, [other.fbc.id]);

        const ownRows = await getLabWorklist(ctx.db, other.facility.id, "all");
        expect(ownRows.map((row) => row.id)).toEqual([otherOrder.labOrderId]);

        const foreignRows = await getLabWorklist(ctx.db, fixture.facility.id, "all");
        expect(foreignRows.map((row) => row.id)).toEqual([order.labOrderId]);
      });
    });
  });
});
