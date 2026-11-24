import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ageFromDob,
  assessVitals,
  calculateBmi,
  deriveTriageCategory,
  isCategoryAtLeast,
} from "../src/lib/triage";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { startVisit } from "../src/server/commands/encounters";
import { registerPatient, type RegisterPatientInput } from "../src/server/commands/patients";
import { queuePatient } from "../src/server/commands/queue";
import { callTriagePatient, recordTriageVitals } from "../src/server/commands/triage";
import {
  auditLog,
  commandLog,
  departments,
  queueEntries,
  rooms,
  triageVitals,
} from "../src/server/db/schema";
import { createEventSubscription, type DomainEvent } from "../src/server/events";
import { getActiveQueue } from "../src/server/queries/queue";

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

async function withFacility<T>(
  run: (facility: { id: string; code: string }, branchId: string) => Promise<T>,
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  try {
    return await run(facility, branchId);
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
    actor: { userId: "vitest" },
    ...overrides,
  };
}

async function queueTriagePatient(
  facility: { id: string; code: string },
  branchId: string,
  overrides: Partial<RegisterPatientInput> = {},
) {
  const registered = await registerPatient(patientInput(facility.id, overrides), {
    database: ctx.db,
  });
  const visit = await startVisit(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      patientId: registered.patientId,
      branchId,
      actor: { userId: "vitest" },
    },
    { database: ctx.db },
  );
  const queued = await queuePatient(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      encounterId: visit.encounterId,
      department: "Triage",
      actor: { userId: "vitest" },
    },
    { database: ctx.db },
  );

  return { ...registered, ...visit, queueEntryId: queued.queueEntryId };
}

async function insertDoctorRoom(facilityId: string, branchId: string, name = "Consult 1") {
  const departmentId = newId();
  await ctx.db.insert(departments).values({
    id: departmentId,
    facilityId,
    branchId,
    name: "Doctor",
    kind: "opd",
    createdBy: "vitest",
  });
  const roomId = newId();
  await ctx.db.insert(rooms).values({
    id: roomId,
    facilityId,
    departmentId,
    name,
    createdBy: "vitest",
  });
  return roomId;
}

function triageInput(
  facilityId: string,
  patient: { encounterId: string; queueEntryId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    facilityId,
    idempotencyKey: newIdempotencyKey(),
    actor: { userId: "vitest" },
    encounterId: patient.encounterId,
    queueEntryId: patient.queueEntryId,
    systolic: 118,
    diastolic: 76,
    heartRate: 72,
    respRate: 16,
    temperature: 36.8,
    spo2: 98,
    weightKg: 64,
    heightCm: 165,
    painScore: 1,
    category: "green" as const,
    chiefComplaint: "Headache for two days",
    comments: "No red flags",
    nextSteps: "Doctor review",
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("triage vitals rules", () => {
  it("calculates BMI from weight and height and rejects unusable measurements", () => {
    expect(calculateBmi(64, 165)).toBe(23.5);
    expect(calculateBmi(70, 175)).toBe(22.9);
    expect(calculateBmi(null, 175)).toBeNull();
    expect(calculateBmi(70, 0)).toBeNull();
    expect(calculateBmi(70, Number.NaN)).toBeNull();
  });

  it("flags normal, warning and critical values with their direction", () => {
    const normal = assessVitals({ systolic: 118, diastolic: 76, heartRate: 72, temperature: 36.8 });
    expect(normal.systolic).toMatchObject({ flag: "normal", direction: null });
    expect(normal.temperature).toMatchObject({ flag: "normal" });

    const warning = assessVitals({ systolic: 145, heartRate: 110, spo2: 92, temperature: 38 });
    expect(warning.systolic).toMatchObject({ flag: "warning", direction: "high" });
    expect(warning.heartRate).toMatchObject({ flag: "warning", direction: "high" });
    expect(warning.spo2).toMatchObject({ flag: "warning", direction: "low" });
    expect(warning.temperature).toMatchObject({ flag: "warning", direction: "high" });

    const critical = assessVitals({ systolic: 190, diastolic: 125, spo2: 85, temperature: 39.5 });
    expect(critical.systolic).toMatchObject({ flag: "critical", direction: "high" });
    expect(critical.diastolic).toMatchObject({ flag: "critical", direction: "high" });
    expect(critical.spo2).toMatchObject({ flag: "critical", direction: "low" });
    expect(critical.temperature).toMatchObject({ flag: "critical", direction: "high" });
  });

  it("includes the auto-calculated BMI in the assessment", () => {
    const assessments = assessVitals({ weightKg: 45, heightCm: 180 });
    expect(assessments.bmi).toMatchObject({ value: 13.9, flag: "critical", direction: "low" });
  });

  it("derives the most severe category the vitals justify", () => {
    expect(deriveTriageCategory(assessVitals({ systolic: 118, heartRate: 72 }))).toBe("green");
    expect(deriveTriageCategory(assessVitals({ systolic: 150 }))).toBe("yellow");
    expect(deriveTriageCategory(assessVitals({ systolic: 60, heartRate: 72 }))).toBe("red");
    expect(deriveTriageCategory(assessVitals({}))).toBe("green");
  });

  it("only allows a category at or above the suggested severity", () => {
    expect(isCategoryAtLeast("green", "green")).toBe(true);
    expect(isCategoryAtLeast("yellow", "green")).toBe(true);
    expect(isCategoryAtLeast("red", "yellow")).toBe(true);
    expect(isCategoryAtLeast("green", "yellow")).toBe(false);
    expect(isCategoryAtLeast("yellow", "red")).toBe(false);
  });

  it("derives age from a date of birth without counting an unborn birthday", () => {
    const now = new Date("2026-11-18T00:00:00");
    expect(ageFromDob("1990-11-18", now)).toBe(36);
    expect(ageFromDob("1990-11-19", now)).toBe(35);
    expect(ageFromDob(null, now)).toBeNull();
  });
});

describe("recordTriageVitals", () => {
  it("stores vitals with BMI and routes the patient to the doctor queue", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      const input = triageInput(facility.id, patient);

      const result = await recordTriageVitals(input, { database: ctx.db });
      expect(result).toMatchObject({ bmi: 23.5, category: "green", suggestedCategory: "green" });
      expect(result.doctorQueueEntryId).not.toBe(patient.queueEntryId);

      const vitalsRows = await ctx.db
        .select()
        .from(triageVitals)
        .where(eq(triageVitals.id, result.triageVitalsId));
      expect(vitalsRows).toHaveLength(1);
      expect(vitalsRows[0]).toMatchObject({
        facilityId: facility.id,
        encounterId: patient.encounterId,
        systolic: 118,
        diastolic: 76,
        heartRate: 72,
        spo2: 98,
        category: "green",
        chiefComplaint: "Headache for two days",
        comments: "No red flags",
        nextSteps: "Doctor review",
        recordedBy: "vitest",
        bmi: "23.5",
        temperature: "36.8",
      });

      const triageEntry = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.id, patient.queueEntryId));
      expect(triageEntry[0]).toMatchObject({ status: "done", priority: "green" });
      expect(triageEntry[0].doneAt).not.toBeNull();

      const doctorEntry = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.id, result.doctorQueueEntryId));
      expect(doctorEntry[0]).toMatchObject({
        department: "Doctor",
        status: "waiting",
        priority: "green",
        encounterId: patient.encounterId,
        patientId: patient.patientId,
      });

      const doctorQueue = await getActiveQueue(ctx.db, facility.id, "Doctor");
      expect(doctorQueue.map((row) => row.id)).toEqual([result.doctorQueueEntryId]);
      const triageQueue = await getActiveQueue(ctx.db, facility.id, "Triage");
      expect(triageQueue).toEqual([]);

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, result.triageVitalsId));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: "triage.record",
        module: "triage",
        entity: "triage_vitals",
        userId: "vitest",
      });
      expect(auditRows[0].details).toMatchObject({
        encounterId: patient.encounterId,
        category: "green",
        bmi: 23.5,
        doctorQueueEntryId: result.doctorQueueEntryId,
      });

      const commandRows = await ctx.db
        .select()
        .from(commandLog)
        .where(eq(commandLog.idempotencyKey, input.idempotencyKey));
      expect(commandRows).toHaveLength(1);
      expect(commandRows[0].command).toBe("recordTriageVitals");
    });
  });

  it("publishes triage and queue events inside the command transaction", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();

      try {
        const result = await recordTriageVitals(
          triageInput(facility.id, patient, { heartRate: 120, category: "yellow" }),
          { database: ctx.db },
        );

        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "triage.recorded" && event.encounterId === patient.encounterId,
          ),
        );
        expect(
          events.find(
            (event) =>
              event.type === "triage.recorded" && event.encounterId === patient.encounterId,
          ),
        ).toMatchObject({ category: "yellow", doctorQueueEntryId: result.doctorQueueEntryId });
        expect(
          events.find(
            (event) => event.type === "queue.queued" && event.encounterId === patient.encounterId,
          ),
        ).toMatchObject({ department: "Doctor", priority: "yellow" });
      } finally {
        await subscription.close();
      }
    });
  });

  it("replays an identical command without duplicating vitals or queue entries", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      const input = triageInput(facility.id, patient);

      const first = await recordTriageVitals(input, { database: ctx.db });
      const replay = await recordTriageVitals(input, { database: ctx.db });
      expect(replay).toEqual(first);

      const vitalsRows = await ctx.db
        .select()
        .from(triageVitals)
        .where(eq(triageVitals.encounterId, patient.encounterId));
      expect(vitalsRows).toHaveLength(1);

      const entries = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.encounterId, patient.encounterId));
      expect(entries.filter((entry) => entry.department === "Doctor")).toHaveLength(1);
      expect(entries.filter((entry) => entry.department === "Triage")).toHaveLength(1);

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, first.triageVitalsId));
      expect(audits).toHaveLength(1);
    });
  });

  it("accepts a category more severe than the vitals suggest", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      const result = await recordTriageVitals(
        triageInput(facility.id, patient, { category: "yellow" }),
        { database: ctx.db },
      );
      expect(result).toMatchObject({ category: "yellow", suggestedCategory: "green" });
    });
  });

  it("rejects a category less severe than the vitals suggest", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      await expect(
        recordTriageVitals(triageInput(facility.id, patient, { spo2: 88 }), {
          database: ctx.db,
        }),
      ).rejects.toThrow(/red category or higher/);
    });
  });

  it("rejects incomplete blood pressure, empty vitals and missing chief complaint", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);

      await expect(
        recordTriageVitals(triageInput(facility.id, patient, { diastolic: null }), {
          database: ctx.db,
        }),
      ).rejects.toThrow(/both systolic and diastolic/);

      await expect(
        recordTriageVitals(
          triageInput(facility.id, patient, {
            systolic: null,
            diastolic: null,
            heartRate: null,
            respRate: null,
            temperature: null,
            spo2: null,
            weightKg: null,
            heightCm: null,
            painScore: null,
            muacCm: null,
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow(/at least one vital/);

      await expect(
        recordTriageVitals(triageInput(facility.id, patient, { chiefComplaint: "" }), {
          database: ctx.db,
        }),
      ).rejects.toThrow();
    });
  });

  it("rejects a patient who is no longer waiting for triage", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      await recordTriageVitals(triageInput(facility.id, patient), { database: ctx.db });

      await expect(
        recordTriageVitals(triageInput(facility.id, patient), { database: ctx.db }),
      ).rejects.toThrow(/no longer waiting for triage/);
    });
  });

  it("rejects encounters and queue entries from another facility", async () => {
    const first = await insertTestFacility(ctx.db);
    const second = await insertTestFacility(ctx.db);
    const firstBranch = await insertTestBranch(ctx.db, first.id);
    const secondBranch = await insertTestBranch(ctx.db, second.id);

    try {
      const patient = await queueTriagePatient(first, firstBranch);

      await expect(
        recordTriageVitals(triageInput(second.id, patient), { database: ctx.db }),
      ).rejects.toThrow(/Encounter not found in this facility/);

      const secondPatient = await queueTriagePatient(second, secondBranch);
      await expect(
        recordTriageVitals(
          triageInput(second.id, {
            encounterId: secondPatient.encounterId,
            queueEntryId: patient.queueEntryId,
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Triage queue entry not found in this facility/);
    } finally {
      await cleanupTestFacility(ctx.db, first.id);
      await cleanupTestFacility(ctx.db, second.id);
    }
  });

  it("rejects triage for a closed encounter", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      await ctx.db.execute(
        // Test-only fixture update: the command itself never closes encounters.
        sql`UPDATE encounters SET status = 'discharged' WHERE id = ${patient.encounterId}::uuid`,
      );

      await expect(
        recordTriageVitals(triageInput(facility.id, patient), { database: ctx.db }),
      ).rejects.toThrow(/Only open encounters/);
    });
  });

  it("stores the selected room on the doctor queue entry and rejects rooms from another facility", async () => {
    const first = await insertTestFacility(ctx.db);
    const second = await insertTestFacility(ctx.db);
    const firstBranch = await insertTestBranch(ctx.db, first.id);
    const secondBranch = await insertTestBranch(ctx.db, second.id);

    try {
      const roomId = await insertDoctorRoom(first.id, firstBranch);
      const otherRoomId = await insertDoctorRoom(second.id, secondBranch);
      const patient = await queueTriagePatient(first, firstBranch);

      const result = await recordTriageVitals(triageInput(first.id, patient, { roomId }), {
        database: ctx.db,
      });
      const doctorEntry = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.id, result.doctorQueueEntryId));
      expect(doctorEntry[0]).toMatchObject({ roomId, department: "Doctor" });

      const anotherPatient = await queueTriagePatient(first, firstBranch);
      await expect(
        recordTriageVitals(triageInput(first.id, anotherPatient, { roomId: otherRoomId }), {
          database: ctx.db,
        }),
      ).rejects.toThrow(/Room does not belong to the facility/);
    } finally {
      await cleanupTestFacility(ctx.db, first.id);
      await cleanupTestFacility(ctx.db, second.id);
    }
  });
});

describe("callTriagePatient", () => {
  it("marks a waiting patient as called with an audit row, event and idempotent replay", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await queueTriagePatient(facility, branchId);
      const input = {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: { userId: "vitest" },
        queueEntryId: patient.queueEntryId,
      };
      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();

      try {
        const result = await callTriagePatient(input, { database: ctx.db });
        expect(result).toEqual({ queueEntryId: patient.queueEntryId, status: "called" });
        expect(await callTriagePatient(input, { database: ctx.db })).toEqual(result);

        const rows = await ctx.db
          .select()
          .from(queueEntries)
          .where(eq(queueEntries.id, patient.queueEntryId));
        expect(rows[0]).toMatchObject({ status: "called" });
        expect(rows[0].calledAt).not.toBeNull();

        const audits = await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.entityId, patient.queueEntryId));
        expect(audits.filter((row) => row.action === "triage.call")).toHaveLength(1);

        const commands = await ctx.db
          .select()
          .from(commandLog)
          .where(eq(commandLog.idempotencyKey, input.idempotencyKey));
        expect(commands).toHaveLength(1);

        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "triage.called" && event.queueEntryId === patient.queueEntryId,
          ),
        );
      } finally {
        await subscription.close();
      }
    });
  });

  it("does not call a patient who already left triage and rejects another facility", async () => {
    const first = await insertTestFacility(ctx.db);
    const second = await insertTestFacility(ctx.db);
    const firstBranch = await insertTestBranch(ctx.db, first.id);

    try {
      const patient = await queueTriagePatient(first, firstBranch);
      await recordTriageVitals(triageInput(first.id, patient), { database: ctx.db });
      await expect(
        callTriagePatient(
          {
            facilityId: first.id,
            idempotencyKey: newIdempotencyKey(),
            actor: { userId: "vitest" },
            queueEntryId: patient.queueEntryId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/no longer waiting for triage/);

      const waiting = await queueTriagePatient(first, firstBranch);
      await expect(
        callTriagePatient(
          {
            facilityId: second.id,
            idempotencyKey: newIdempotencyKey(),
            actor: { userId: "vitest" },
            queueEntryId: waiting.queueEntryId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Triage queue entry not found/);
    } finally {
      await cleanupTestFacility(ctx.db, first.id);
      await cleanupTestFacility(ctx.db, second.id);
    }
  });
});
