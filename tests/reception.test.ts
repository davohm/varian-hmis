import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { registerPatient, type RegisterPatientInput } from "../src/server/commands/patients";
import { startVisit } from "../src/server/commands/encounters";
import { queuePatient } from "../src/server/commands/queue";
import { auditLog, commandLog, nextOfKin, patients, queueEntries } from "../src/server/db/schema";
import { createEventSubscription, type DomainEvent } from "../src/server/events";
import { findPatientDuplicates, searchPatients } from "../src/server/queries/patients";
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

async function queueNewPatient(
  facility: { id: string; code: string },
  branchId: string,
  overrides: Partial<RegisterPatientInput> = {},
  priority: "red" | "yellow" | "green" | "normal" = "normal",
) {
  const registered = await registerPatient(patientInput(facility.id, overrides), { database: ctx.db });
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
  await queuePatient(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      encounterId: visit.encounterId,
      priority,
      department: "Triage",
      actor: { userId: "vitest" },
    },
    { database: ctx.db },
  );
  return { ...registered, ...visit };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("reception commands", () => {
  it("allocates a sequential MRN and records next of kin and audit", async () => {
    await withFacility(async (facility) => {
      const result = await registerPatient(
        patientInput(facility.id, {
          nextOfKin: [{ name: "Mary Otieno", relationship: "Mother", phone: "0700123456" }],
        }),
        { database: ctx.db },
      );

      expect(result.mrn).toMatch(new RegExp(`^${facility.code}-\\d{2}-\\d{5}$`));
      const rows = await ctx.db.select().from(patients).where(eq(patients.id, result.patientId));
      expect(rows[0]).toMatchObject({ firstName: "Amina", lastName: "Otieno", mrn: result.mrn });
      expect(rows[0].dob).toBe("1990-04-12");

      const kinRows = await ctx.db
        .select()
        .from(nextOfKin)
        .where(eq(nextOfKin.patientId, result.patientId));
      expect(kinRows).toHaveLength(1);
      expect(kinRows[0].name).toBe("Mary Otieno");

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, result.patientId));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].action).toBe("patient.register");
      expect(auditRows[0].details).toMatchObject({ mrn: result.mrn });
    });
  });

  it("never repeats or skips MRNs across sequential registrations", async () => {
    await withFacility(async (facility) => {
      const results = [];
      for (let index = 0; index < 3; index += 1) {
        results.push(
          await registerPatient(patientInput(facility.id, { firstName: `Patient${index}` }), {
            database: ctx.db,
          }),
        );
      }
      const suffixes = results.map((result) => Number(result.mrn.split("-").at(-1)));
      expect(suffixes).toEqual([suffixes[0], suffixes[0] + 1, suffixes[0] + 2]);
    });
  });

  it("replays the same idempotency key without creating a second patient", async () => {
    await withFacility(async (facility) => {
      const input = patientInput(facility.id);
      const first = await registerPatient(input, { database: ctx.db });
      const replay = await registerPatient(input, { database: ctx.db });

      expect(replay).toEqual(first);
      const rows = await ctx.db.select().from(patients).where(eq(patients.facilityId, facility.id));
      expect(rows).toHaveLength(1);
      const commands = await ctx.db
        .select()
        .from(commandLog)
        .where(eq(commandLog.idempotencyKey, input.idempotencyKey));
      expect(commands).toHaveLength(1);
    });
  });

  it("handles concurrent replays of one key with a single write", async () => {
    await withFacility(async (facility) => {
      const input = patientInput(facility.id);
      const [first, second] = await Promise.all([
        registerPatient(input, { database: ctx.db }),
        registerPatient(input, { database: ctx.db }),
      ]);

      expect(second).toEqual(first);
      const rows = await ctx.db.select().from(patients).where(eq(patients.facilityId, facility.id));
      expect(rows).toHaveLength(1);
    });
  });

  it("replays startVisit and queuePatient without duplicate side effects", async () => {
    await withFacility(async (facility, branchId) => {
      const patient = await registerPatient(patientInput(facility.id), { database: ctx.db });
      const visitInput = {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        patientId: patient.patientId,
        branchId,
        actor: { userId: "vitest" },
      };
      const firstVisit = await startVisit(visitInput, { database: ctx.db });
      const replayedVisit = await startVisit(visitInput, { database: ctx.db });
      expect(replayedVisit).toEqual(firstVisit);

      const queueInput = {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        encounterId: firstVisit.encounterId,
        department: "Triage",
        actor: { userId: "vitest" },
      };
      const firstQueue = await queuePatient(queueInput, { database: ctx.db });
      const replayedQueue = await queuePatient(queueInput, { database: ctx.db });
      expect(replayedQueue).toEqual(firstQueue);

      const visitRows = await ctx.db
        .select()
        .from(commandLog)
        .where(eq(commandLog.idempotencyKey, visitInput.idempotencyKey));
      const queueRows = await ctx.db
        .select()
        .from(commandLog)
        .where(eq(commandLog.idempotencyKey, queueInput.idempotencyKey));
      expect(visitRows).toHaveLength(1);
      expect(queueRows).toHaveLength(1);

      const queue = await getActiveQueue(ctx.db, facility.id, "Triage");
      expect(queue.filter((row) => row.encounterId === firstVisit.encounterId)).toHaveLength(1);

      const visitAudit = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, firstVisit.encounterId));
      expect(visitAudit[0].action).toBe("encounter.start");
      const queueAudit = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, firstQueue.queueEntryId));
      expect(queueAudit[0].action).toBe("queue.enqueue");
    });
  });

  it("flags duplicates by national ID or phone plus DOB only", async () => {
    await withFacility(async (facility) => {
      const existing = await registerPatient(
        patientInput(facility.id, { nationalId: "ID-DUPLICATE", phone: "0722000000", dob: "1988-06-01" }),
        { database: ctx.db },
      );

      const byNationalId = await findPatientDuplicates(ctx.db, facility.id, {
        nationalId: "id-duplicate",
      });
      const byPhoneAndDob = await findPatientDuplicates(ctx.db, facility.id, {
        phone: "0722000000",
        dob: "1988-06-01",
      });
      const wrongDob = await findPatientDuplicates(ctx.db, facility.id, {
        phone: "0722000000",
        dob: "1988-06-02",
      });

      expect(byNationalId.map((row) => row.id)).toContain(existing.patientId);
      expect(byPhoneAndDob.map((row) => row.id)).toContain(existing.patientId);
      expect(wrongDob).toEqual([]);
    });
  });

  it("searches by name, MRN and phone, scoped to the facility", async () => {
    const first = await insertTestFacility(ctx.db);
    const second = await insertTestFacility(ctx.db);
    try {
      const target = await registerPatient(
        patientInput(first.id, { firstName: "Amina", lastName: "Otieno", phone: "0711111111" }),
        { database: ctx.db },
      );
      await registerPatient(
        patientInput(first.id, { firstName: "Brian", lastName: "Ochieng", phone: "0722222222" }),
        { database: ctx.db },
      );
      await registerPatient(
        patientInput(second.id, { firstName: "Amina", lastName: "Otieno", phone: "0711111111" }),
        { database: ctx.db },
      );

      const byName = await searchPatients(ctx.db, first.id, "amin");
      const byMrn = await searchPatients(ctx.db, first.id, target.mrn.toLowerCase());
      const byPhone = await searchPatients(ctx.db, first.id, "711111");

      expect(byName.map((row) => row.id)).toEqual([target.patientId]);
      expect(byMrn.map((row) => row.id)).toEqual([target.patientId]);
      expect(byPhone.map((row) => row.id)).toContain(target.patientId);
    } finally {
      await cleanupTestFacility(ctx.db, first.id);
      await cleanupTestFacility(ctx.db, second.id);
    }
  });

  it("starts an encounter and queues the patient for triage", async () => {
    await withFacility(async (facility, branchId) => {
      const queued = await queueNewPatient(facility, branchId);
      expect(queued.encounterNo).toMatch(new RegExp(`^${facility.code}-E-\\d{2}-\\d{6}$`));

      const queue = await getActiveQueue(ctx.db, facility.id, "Triage");
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({
        patientId: queued.patientId,
        encounterId: queued.encounterId,
        priority: "normal",
        status: "waiting",
      });
      const entryRows = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.encounterId, queued.encounterId));
      expect(entryRows).toHaveLength(1);
    });
  });

  it("orders the triage queue by clinical priority then arrival", async () => {
    await withFacility(async (facility, branchId) => {
      await queueNewPatient(facility, branchId, { firstName: "Normal" }, "normal");
      await queueNewPatient(facility, branchId, { firstName: "Yellow" }, "yellow");
      await queueNewPatient(facility, branchId, { firstName: "Red" }, "red");

      const queue = await getActiveQueue(ctx.db, facility.id, "Triage");
      expect(queue.map((row) => row.priority)).toEqual(["red", "yellow", "normal"]);
      expect(queue[2].firstName).toBe("Normal");
    });
  });

  it("rejects cross-facility visit and queue writes", async () => {
    const first = await insertTestFacility(ctx.db);
    const firstBranch = await insertTestBranch(ctx.db, first.id);
    const second = await insertTestFacility(ctx.db);
    const secondBranch = await insertTestBranch(ctx.db, second.id);
    try {
      const patient = await registerPatient(patientInput(first.id), { database: ctx.db });

      await expect(
        startVisit(
          {
            facilityId: second.id,
            idempotencyKey: newIdempotencyKey(),
            patientId: patient.patientId,
            branchId: secondBranch,
            actor: { userId: "vitest" },
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("Patient not found in this facility");

      const visit = await startVisit(
        {
          facilityId: first.id,
          idempotencyKey: newIdempotencyKey(),
          patientId: patient.patientId,
          branchId: firstBranch,
          actor: { userId: "vitest" },
        },
        { database: ctx.db },
      );
      await expect(
        queuePatient(
          {
            facilityId: second.id,
            idempotencyKey: newIdempotencyKey(),
            encounterId: visit.encounterId,
            actor: { userId: "vitest" },
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("Encounter not found in this facility");
    } finally {
      await cleanupTestFacility(ctx.db, first.id);
      await cleanupTestFacility(ctx.db, second.id);
    }
  });

  it("notifies LISTEN subscribers when a patient is registered and queued", async () => {
    await withFacility(async (facility, branchId) => {
      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => {
        if (event.facilityId === facility.id) events.push(event);
      });
      await subscription.listen();
      try {
        await queueNewPatient(facility, branchId);
        await waitUntil(() => events.some((event) => event.type === "patient.registered"));
        await waitUntil(() => events.some((event) => event.type === "queue_changed"));
      } finally {
        await subscription.close();
      }
    });
  });
});
