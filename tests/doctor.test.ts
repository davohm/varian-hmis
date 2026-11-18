import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLINICAL_NOTE_LOCKED_MESSAGE,
  CLOSED_ENCOUNTER_MESSAGE,
  OUTSTANDING_LAB_MESSAGE,
  canCancelLabOrder,
  canCancelPrescription,
} from "../src/lib/clinical";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  cancelLabOrder,
  cancelPrescription,
  dischargeEncounter,
  orderLabTests,
  prescribe,
  recordDiagnosis,
  saveClinicalNote,
  startConsultation,
  voidDiagnosis,
} from "../src/server/commands/clinical";
import { startVisit } from "../src/server/commands/encounters";
import { registerPatient, type RegisterPatientInput } from "../src/server/commands/patients";
import { queuePatient } from "../src/server/commands/queue";
import { recordTriageVitals } from "../src/server/commands/triage";
import {
  auditLog,
  clinicalNotes,
  commandLog,
  diagnoses,
  encounters,
  icd10Codes,
  items,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  prescriptions,
  queueEntries,
} from "../src/server/db/schema";
import { createEventSubscription, type DomainEvent } from "../src/server/events";
import {
  getEncounterClinicalDetail,
  listDrugs,
  listLabTests,
  searchIcd10,
} from "../src/server/queries/clinical";

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

interface ClinicalFixture {
  facility: { id: string; code: string };
  branchId: string;
  suffix: string;
  labTest: { id: string; code: string; name: string };
  otherLabTest: { id: string; code: string; name: string };
  drug: { id: string; name: string };
  consumable: { id: string; name: string };
  icd: { code: string; description: string };
  icdOther: { code: string; description: string };
}

/**
 * A facility with its own lab tests, drug catalogue and two ICD-10 codes, so
 * every rule can be exercised without depending on seed data. The ICD codes
 * are global rows, so they are removed explicitly after the facility cleanup.
 */
async function withClinicalFacility<T>(run: (fixture: ClinicalFixture) => Promise<T>): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

  const labTest = {
    id: newId(),
    code: `FBC${suffix}`,
    name: `Full Blood Count ${suffix}`,
  };
  const otherLabTest = {
    id: newId(),
    code: `MP${suffix}`,
    name: `Malaria Parasites ${suffix}`,
  };
  const drug = { id: newId(), name: `Paracetamol ${suffix}` };
  const consumable = { id: newId(), name: `Examination gloves ${suffix}` };
  const icd = { code: `X${suffix}`, description: `Test condition alpha ${suffix}` };
  const icdOther = { code: `Y${suffix}`, description: `Test condition beta ${suffix}` };

  await ctx.db.insert(labTests).values([
    {
      id: labTest.id,
      facilityId: facility.id,
      code: labTest.code,
      name: labTest.name,
      sampleType: "Whole blood (EDTA)",
      parameters: [
        {
          name: "Haemoglobin",
          unit: "g/dL",
          refLow: 12,
          refHigh: 17,
          criticalLow: 7,
          criticalHigh: 20,
        },
      ],
      createdBy: "vitest",
    },
    {
      id: otherLabTest.id,
      facilityId: facility.id,
      code: otherLabTest.code,
      name: otherLabTest.name,
      sampleType: "Whole blood (EDTA)",
      parameters: [
        {
          name: "Parasite density",
          unit: "parasites/uL",
          refLow: null,
          refHigh: 0,
          criticalLow: null,
          criticalHigh: 100000,
        },
      ],
      createdBy: "vitest",
    },
  ]);

  await ctx.db.insert(items).values([
    {
      id: drug.id,
      facilityId: facility.id,
      code: `PARA${suffix}`,
      name: drug.name,
      kind: "drug",
      unit: "tablet",
      strength: "500 mg",
      form: "Tablet",
      createdBy: "vitest",
    },
    {
      id: consumable.id,
      facilityId: facility.id,
      code: `GLV${suffix}`,
      name: consumable.name,
      kind: "consumable",
      unit: "pair",
      createdBy: "vitest",
    },
  ]);

  await ctx.db.insert(icd10Codes).values([
    { id: newId(), code: icd.code, description: icd.description, chapter: "Test" },
    { id: newId(), code: icdOther.code, description: icdOther.description, chapter: "Test" },
  ]);

  try {
    return await run({
      facility,
      branchId,
      suffix,
      labTest,
      otherLabTest,
      drug,
      consumable,
      icd,
      icdOther,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
    await ctx.db
      .delete(icd10Codes)
      .where(inArray(icd10Codes.code, [icd.code, icdOther.code]));
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

async function startTestVisit(fixture: ClinicalFixture, patientId: string) {
  return startVisit(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      patientId,
      branchId: fixture.branchId,
      actor: ACTOR,
    },
    { database: ctx.db },
  );
}

interface DoctorVisit {
  patientId: string;
  mrn: string;
  encounterId: string;
  encounterNo: string;
  triageQueueEntryId: string;
  doctorQueueEntryId: string;
}

/** Register, start a visit, triage it and let triage hand the patient to the doctor. */
async function createDoctorVisit(
  fixture: ClinicalFixture,
  overrides: Partial<RegisterPatientInput> = {},
): Promise<DoctorVisit> {
  const registered = await registerPatient(patientInput(fixture.facility.id, overrides), {
    database: ctx.db,
  });
  const visit = await startTestVisit(fixture, registered.patientId);
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
    triageQueueEntryId: triage.queueEntryId,
    doctorQueueEntryId: vitals.doctorQueueEntryId,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function noteInput(
  fixture: ClinicalFixture,
  visit: DoctorVisit,
  overrides: Record<string, unknown> = {},
) {
  return {
    facilityId: fixture.facility.id,
    idempotencyKey: newIdempotencyKey(),
    actor: ACTOR,
    encounterId: visit.encounterId,
    subjective: "Headache for two days, no vomiting",
    objective: "Alert, afebrile, no neck stiffness",
    assessment: "Tension-type headache",
    plan: "Paracetamol, review in three days",
    sign: false,
    ...overrides,
  };
}

describe("clinical cancellation rules", () => {
  it("allows a laboratory order to be cancelled until a result is returned", () => {
    expect(canCancelLabOrder("ordered")).toBe(true);
    expect(canCancelLabOrder("collected")).toBe(true);
    expect(canCancelLabOrder("in_progress")).toBe(true);
    expect(canCancelLabOrder("resulted")).toBe(false);
    expect(canCancelLabOrder("verified")).toBe(false);
    expect(canCancelLabOrder("cancelled")).toBe(false);
  });

  it("only allows an untouched prescription to be cancelled", () => {
    expect(canCancelPrescription("prescribed")).toBe(true);
    expect(canCancelPrescription("partial")).toBe(false);
    expect(canCancelPrescription("dispensed")).toBe(false);
    expect(canCancelPrescription("cancelled")).toBe(false);
  });
});

describe("startConsultation", () => {
  it("moves the doctor queue entry into service and audits the handover", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        encounterId: visit.encounterId,
        queueEntryId: visit.doctorQueueEntryId,
      };

      const result = await startConsultation(input, { database: ctx.db });
      expect(result).toEqual({
        encounterId: visit.encounterId,
        queueEntryId: visit.doctorQueueEntryId,
        status: "in_service",
      });

      const rows = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.id, visit.doctorQueueEntryId));
      expect(rows[0]).toMatchObject({ status: "in_service", department: "Doctor" });
      expect(rows[0].calledAt).not.toBeNull();

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, visit.doctorQueueEntryId));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: "consultation.start",
        module: "doctor",
        entity: "queue_entries",
        userId: "vitest",
      });
      expect(auditRows[0].details).toMatchObject({
        encounterId: visit.encounterId,
        encounterNo: visit.encounterNo,
        patientId: visit.patientId,
      });

      const replay = await startConsultation(input, { database: ctx.db });
      expect(replay).toEqual(result);
      const replayAudits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, visit.doctorQueueEntryId));
      expect(replayAudits).toHaveLength(1);
    });
  });

  it("rejects a patient who is not waiting for a doctor", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);

      await expect(
        startConsultation(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            queueEntryId: visit.triageQueueEntryId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/not waiting for a doctor/);

      await expect(
        startConsultation(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            queueEntryId: newId(),
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/not waiting for a doctor/);
    });
  });

  it("rejects a closed encounter and another facility's encounter", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      await dischargeEncounter(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          outcome: "discharged",
        },
        { database: ctx.db },
      );

      await expect(
        startConsultation(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            queueEntryId: visit.doctorQueueEntryId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Only open visits/);

      const other = await insertTestFacility(ctx.db);
      try {
        await expect(
          startConsultation(
            {
              facilityId: other.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              encounterId: visit.encounterId,
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/Encounter not found in this facility/);
      } finally {
        await cleanupTestFacility(ctx.db, other.id);
      }
    });
  });
});

describe("saveClinicalNote", () => {
  it("saves a draft note, merges partial updates and records one audit row", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const input = noteInput(fixture, visit);

      const first = await saveClinicalNote(input, { database: ctx.db });
      expect(first.signedAt).toBeNull();

      const rows = await ctx.db
        .select()
        .from(clinicalNotes)
        .where(eq(clinicalNotes.encounterId, visit.encounterId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        facilityId: fixture.facility.id,
        subjective: "Headache for two days, no vomiting",
        objective: "Alert, afebrile, no neck stiffness",
        assessment: "Tension-type headache",
        plan: "Paracetamol, review in three days",
        authorId: "vitest",
        signedAt: null,
      });

      const merged = await saveClinicalNote(
        noteInput(fixture, visit, {
          subjective: undefined,
          assessment: "Migraine without aura",
          plan: undefined,
        }),
        { database: ctx.db },
      );
      expect(merged.noteId).toBe(first.noteId);

      const mergedRows = await ctx.db
        .select()
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, first.noteId));
      expect(mergedRows[0]).toMatchObject({
        subjective: "Headache for two days, no vomiting",
        objective: "Alert, afebrile, no neck stiffness",
        assessment: "Migraine without aura",
        plan: "Paracetamol, review in three days",
      });

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, first.noteId));
      expect(auditRows).toHaveLength(2);
      expect(auditRows.map((row) => row.action).sort()).toEqual([
        "clinical_note.save",
        "clinical_note.save",
      ]);

      const replay = await saveClinicalNote(input, { database: ctx.db });
      expect(replay).toEqual(first);
      const replayRows = await ctx.db
        .select()
        .from(clinicalNotes)
        .where(eq(clinicalNotes.encounterId, visit.encounterId));
      expect(replayRows).toHaveLength(1);
      const commandRows = await ctx.db
        .select()
        .from(commandLog)
        .where(eq(commandLog.idempotencyKey, input.idempotencyKey));
      expect(commandRows).toHaveLength(1);
      expect(commandRows[0].command).toBe("saveClinicalNote");
    });
  });

  it("requires content, and requires assessment and plan to sign", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);

      await expect(
        saveClinicalNote(
          noteInput(fixture, visit, {
            subjective: "",
            objective: "",
            assessment: "",
            plan: "",
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow(/at least one section/);

      await expect(
        saveClinicalNote(
          noteInput(fixture, visit, { assessment: "", plan: "", sign: true }),
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Assessment and plan are required/);
    });
  });

  it("locks the note once signed and publishes a saved event", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();

      try {
        const signed = await saveClinicalNote(noteInput(fixture, visit, { sign: true }), {
          database: ctx.db,
        });
        expect(signed.signedAt).not.toBeNull();

        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "clinical_note.saved" && event.encounterId === visit.encounterId,
          ),
        );
        expect(
          events.find(
            (event) =>
              event.type === "clinical_note.saved" && event.encounterId === visit.encounterId,
          ),
        ).toMatchObject({
          noteId: signed.noteId,
          signed: true,
        });

        await expect(
          saveClinicalNote(noteInput(fixture, visit, { subjective: "Changed" }), {
            database: ctx.db,
          }),
        ).rejects.toThrow(CLINICAL_NOTE_LOCKED_MESSAGE);

        const rows = await ctx.db
          .select()
          .from(clinicalNotes)
          .where(eq(clinicalNotes.id, signed.noteId));
        expect(rows[0].subjective).toBe("Headache for two days, no vomiting");
        expect(rows[0].signedAt).not.toBeNull();
      } finally {
        await subscription.close();
      }
    });
  });

  it("rejects a note for a closed encounter", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      await dischargeEncounter(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          outcome: "discharged",
        },
        { database: ctx.db },
      );

      await expect(
        saveClinicalNote(noteInput(fixture, visit), { database: ctx.db }),
      ).rejects.toThrow(/Only open visits/);
    });
  });
});

describe("recordDiagnosis and voidDiagnosis", () => {
  it("records a coded diagnosis from the catalogue", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        encounterId: visit.encounterId,
        icd10Code: fixture.icd.code.toLowerCase(),
        isPrimary: true,
      };

      const result = await recordDiagnosis(input, { database: ctx.db });
      expect(result).toMatchObject({
        code: fixture.icd.code,
        description: fixture.icd.description,
        isPrimary: true,
      });

      const rows = await ctx.db
        .select()
        .from(diagnoses)
        .where(eq(diagnoses.id, result.diagnosisId));
      expect(rows[0]).toMatchObject({
        facilityId: fixture.facility.id,
        encounterId: visit.encounterId,
        icd10Code: fixture.icd.code,
        description: fixture.icd.description,
        isPrimary: true,
        diagnosedBy: "vitest",
        voidedAt: null,
      });

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, result.diagnosisId));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({ action: "diagnosis.record", module: "doctor" });

      const replay = await recordDiagnosis(input, { database: ctx.db });
      expect(replay).toEqual(result);
      const replayRows = await ctx.db
        .select()
        .from(diagnoses)
        .where(eq(diagnoses.encounterId, visit.encounterId));
      expect(replayRows).toHaveLength(1);
    });
  });

  it("keeps a single primary diagnosis per encounter", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);

      const first = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icd.code,
          isPrimary: true,
        },
        { database: ctx.db },
      );
      const second = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icdOther.code,
          isPrimary: true,
        },
        { database: ctx.db },
      );

      const rows = await ctx.db
        .select()
        .from(diagnoses)
        .where(eq(diagnoses.encounterId, visit.encounterId));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === first.diagnosisId)?.isPrimary).toBe(false);
      expect(rows.find((row) => row.id === second.diagnosisId)?.isPrimary).toBe(true);
    });
  });

  it("rejects duplicate codes until the previous one is voided", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const first = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icd.code,
        },
        { database: ctx.db },
      );

      await expect(
        recordDiagnosis(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            icd10Code: fixture.icd.code,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already recorded/);

      await voidDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          diagnosisId: first.diagnosisId,
        },
        { database: ctx.db },
      );

      const reRecorded = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icd.code,
        },
        { database: ctx.db },
      );
      expect(reRecorded.diagnosisId).not.toBe(first.diagnosisId);
    });
  });

  it("rejects an unknown ICD-10 code", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      await expect(
        recordDiagnosis(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            icd10Code: "ZZZ999",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Unknown ICD-10 code: ZZZ999/);
    });
  });

  it("voids a diagnosis once and only for its own encounter", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const otherVisit = await createDoctorVisit(fixture, {
        firstName: "Brian",
        nationalId: `ID-${newId().slice(0, 8)}`,
      });
      const recorded = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icd.code,
        },
        { database: ctx.db },
      );

      const voided = await voidDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          diagnosisId: recorded.diagnosisId,
        },
        { database: ctx.db },
      );
      expect(voided.diagnosisId).toBe(recorded.diagnosisId);

      const rows = await ctx.db
        .select()
        .from(diagnoses)
        .where(eq(diagnoses.id, recorded.diagnosisId));
      expect(rows[0].voidedAt).not.toBeNull();
      expect(rows[0].voidedBy).toBe("vitest");

      await expect(
        voidDiagnosis(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            diagnosisId: recorded.diagnosisId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already voided/);

      await expect(
        voidDiagnosis(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: otherVisit.encounterId,
            diagnosisId: recorded.diagnosisId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/not found for this visit/);
    });
  });
});

describe("orderLabTests and cancelLabOrder", () => {
  it("creates one order with an item per available test", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        encounterId: visit.encounterId,
        labTestIds: [fixture.labTest.id, fixture.otherLabTest.id],
        clinicalNotes: "Rule out anaemia and malaria",
      };

      const result = await orderLabTests(input, { database: ctx.db });
      expect(result.status).toBe("ordered");
      expect(result.itemIds).toHaveLength(2);

      const orderRows = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, result.labOrderId));
      expect(orderRows[0]).toMatchObject({
        facilityId: fixture.facility.id,
        encounterId: visit.encounterId,
        status: "ordered",
        clinicalNotes: "Rule out anaemia and malaria",
        orderedBy: "vitest",
      });

      const itemRows = await ctx.db
        .select()
        .from(labOrderItems)
        .where(eq(labOrderItems.labOrderId, result.labOrderId));
      expect(itemRows).toHaveLength(2);
      expect(itemRows.map((row) => row.status)).toEqual(["ordered", "ordered"]);
      expect(itemRows.map((row) => row.labTestId).sort()).toEqual(
        [fixture.labTest.id, fixture.otherLabTest.id].sort(),
      );

      const replay = await orderLabTests(input, { database: ctx.db });
      expect(replay).toEqual(result);
      const replayItems = await ctx.db
        .select()
        .from(labOrderItems)
        .where(eq(labOrderItems.labOrderId, result.labOrderId));
      expect(replayItems).toHaveLength(2);
    });
  });

  it("rejects tests that are not available at the facility", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);

      await expect(
        orderLabTests(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            labTestIds: [newId()],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/not available at this facility/);

      const other = await insertTestFacility(ctx.db);
      const foreignTestId = newId();
      await ctx.db.insert(labTests).values({
        id: foreignTestId,
        facilityId: other.id,
        code: `FRN${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        name: "Foreign test",
        sampleType: "Serum",
        parameters: [],
        createdBy: "vitest",
      });

      try {
        await expect(
          orderLabTests(
            {
              facilityId: fixture.facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              encounterId: visit.encounterId,
              labTestIds: [foreignTestId],
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/not available at this facility/);
      } finally {
        await cleanupTestFacility(ctx.db, other.id);
      }
    });
  });

  it("cancels an order and its open items, but not after a result", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const order = await orderLabTests(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labTestIds: [fixture.labTest.id],
        },
        { database: ctx.db },
      );

      const cancelled = await cancelLabOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labOrderId: order.labOrderId,
        },
        { database: ctx.db },
      );
      expect(cancelled.status).toBe("cancelled");

      const orderRows = await ctx.db
        .select()
        .from(labOrders)
        .where(eq(labOrders.id, order.labOrderId));
      expect(orderRows[0].status).toBe("cancelled");
      const itemRows = await ctx.db
        .select()
        .from(labOrderItems)
        .where(eq(labOrderItems.labOrderId, order.labOrderId));
      expect(itemRows.map((row) => row.status)).toEqual(["cancelled"]);

      await expect(
        cancelLabOrder(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            labOrderId: order.labOrderId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already cancelled/);

      const resultedOrder = await orderLabTests(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labTestIds: [fixture.otherLabTest.id],
        },
        { database: ctx.db },
      );
      await ctx.db.execute(
        // Test-only fixture: the laboratory result workflow is built in a later prompt.
        sql`UPDATE lab_orders SET status = 'resulted' WHERE id = ${resultedOrder.labOrderId}::uuid`,
      );

      await expect(
        cancelLabOrder(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            labOrderId: resultedOrder.labOrderId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Results have already been returned/);
    });
  });
});

describe("prescribe and cancelPrescription", () => {
  it("prescribes a drug with dose, route, frequency and quantity", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        encounterId: visit.encounterId,
        itemId: fixture.drug.id,
        dose: "1 tablet",
        route: "oral" as const,
        frequency: "three times daily" as const,
        durationDays: 5,
        quantity: 15,
        instructions: "Take after food",
      };

      const result = await prescribe(input, { database: ctx.db });
      expect(result.status).toBe("prescribed");

      const rows = await ctx.db
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, result.prescriptionId));
      expect(rows[0]).toMatchObject({
        facilityId: fixture.facility.id,
        encounterId: visit.encounterId,
        itemId: fixture.drug.id,
        dose: "1 tablet",
        route: "oral",
        frequency: "three times daily",
        durationDays: 5,
        quantity: 15,
        instructions: "Take after food",
        status: "prescribed",
        prescribedBy: "vitest",
      });

      const replay = await prescribe(input, { database: ctx.db });
      expect(replay).toEqual(result);
      const replayRows = await ctx.db
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.encounterId, visit.encounterId));
      expect(replayRows).toHaveLength(1);
    });
  });

  it("only prescribes drug items", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);

      await expect(
        prescribe(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            itemId: fixture.consumable.id,
            dose: "1 pair",
            route: "topical",
            frequency: "as needed",
            quantity: 1,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Only medicines can be prescribed/);

      await expect(
        prescribe(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            itemId: newId(),
            dose: "1 tablet",
            route: "oral",
            frequency: "once daily",
            quantity: 1,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Medicine not found in this facility/);
    });
  });

  it("cancels a prescribed medicine but not a dispensed one", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const prescribed = await prescribe(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          itemId: fixture.drug.id,
          dose: "1 tablet",
          route: "oral",
          frequency: "once daily",
          quantity: 5,
        },
        { database: ctx.db },
      );

      const cancelled = await cancelPrescription(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          prescriptionId: prescribed.prescriptionId,
        },
        { database: ctx.db },
      );
      expect(cancelled.status).toBe("cancelled");

      const rows = await ctx.db
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, prescribed.prescriptionId));
      expect(rows[0]).toMatchObject({ status: "cancelled", cancelledBy: "vitest" });
      expect(rows[0].cancelledAt).not.toBeNull();

      await expect(
        cancelPrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            prescriptionId: prescribed.prescriptionId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already cancelled/);

      const dispensed = await prescribe(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          itemId: fixture.drug.id,
          dose: "1 tablet",
          route: "oral",
          frequency: "twice daily",
          quantity: 10,
        },
        { database: ctx.db },
      );
      await ctx.db.execute(
        // Test-only fixture: the pharmacy dispense workflow is built in a later prompt.
        sql`UPDATE prescriptions SET status = 'dispensed' WHERE id = ${dispensed.prescriptionId}::uuid`,
      );

      await expect(
        cancelPrescription(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            prescriptionId: dispensed.prescriptionId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Dispensed prescriptions cannot be cancelled/);
    });
  });
});

describe("dischargeEncounter", () => {
  it("blocks a visit with outstanding laboratory work and closes it after cancellation", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const order = await orderLabTests(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labTestIds: [fixture.labTest.id],
        },
        { database: ctx.db },
      );

      await expect(
        dischargeEncounter(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            outcome: "discharged",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(OUTSTANDING_LAB_MESSAGE);

      await cancelLabOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labOrderId: order.labOrderId,
        },
        { database: ctx.db },
      );

      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        encounterId: visit.encounterId,
        outcome: "discharged" as const,
        outcomeNotes: "Symptoms resolved, follow up if worse",
      };
      const result = await dischargeEncounter(input, { database: ctx.db });
      expect(result).toMatchObject({ encounterId: visit.encounterId, status: "discharged" });
      expect(result.endedAt).toBeTruthy();

      const encounterRows = await ctx.db
        .select()
        .from(encounters)
        .where(eq(encounters.id, visit.encounterId));
      expect(encounterRows[0]).toMatchObject({
        status: "discharged",
        outcome: "Symptoms resolved, follow up if worse",
      });
      expect(encounterRows[0].endedAt).not.toBeNull();

      const queueRows = await ctx.db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.id, visit.doctorQueueEntryId));
      expect(queueRows[0].status).toBe("done");
      expect(queueRows[0].doneAt).not.toBeNull();

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, visit.encounterId));
      expect(
        auditRows.filter((row) => row.action === "encounter.discharge"),
      ).toHaveLength(1);

      const replay = await dischargeEncounter(input, { database: ctx.db });
      expect(replay).toEqual(result);
      const replayAudits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, visit.encounterId));
      expect(replayAudits.filter((row) => row.action === "encounter.discharge")).toHaveLength(1);
    });
  });

  it("records a referral outcome and rejects a second close", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);

      const referred = await dischargeEncounter(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          outcome: "referred",
          outcomeNotes: "Referred to county hospital",
        },
        { database: ctx.db },
      );
      expect(referred.status).toBe("referred");

      const rows = await ctx.db
        .select()
        .from(encounters)
        .where(eq(encounters.id, visit.encounterId));
      expect(rows[0]).toMatchObject({
        status: "referred",
        outcome: "Referred to county hospital",
      });

      const auditRows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, visit.encounterId));
      expect(auditRows.some((row) => row.action === "encounter.refer")).toBe(true);

      await expect(
        dischargeEncounter(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            outcome: "discharged",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(CLOSED_ENCOUNTER_MESSAGE);
    });
  });

  it("publishes the closure and queue events inside the transaction", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const events: DomainEvent[] = [];
      const subscription = createEventSubscription((event) => events.push(event));
      await subscription.listen();

      try {
        await dischargeEncounter(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            encounterId: visit.encounterId,
            outcome: "discharged",
          },
          { database: ctx.db },
        );

        await waitUntil(() =>
          events.some(
            (event) =>
              event.type === "encounter.closed" && event.encounterId === visit.encounterId,
          ),
        );
        expect(
          events.find(
            (event) =>
              event.type === "encounter.closed" && event.encounterId === visit.encounterId,
          ),
        ).toMatchObject({
          outcome: "discharged",
          patientId: visit.patientId,
        });
        expect(
          events.some(
            (event) =>
              event.type === "queue.changed" &&
              event.encounterId === visit.encounterId &&
              event.status === "done",
          ),
        ).toBe(true);
      } finally {
        await subscription.close();
      }
    });
  });
});

describe("getEncounterClinicalDetail", () => {
  it("assembles the banner, notes, diagnoses, orders, results, prescriptions and history", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const previous = await startTestVisit(fixture, visit.patientId);

      await saveClinicalNote(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: previous.encounterId,
          subjective: "Fever and chills",
          assessment: "Malaria",
          plan: "Artemether-lumefantrine",
          sign: true,
        },
        { database: ctx.db },
      );
      await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: previous.encounterId,
          icd10Code: fixture.icdOther.code,
          isPrimary: true,
        },
        { database: ctx.db },
      );
      await dischargeEncounter(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: previous.encounterId,
          outcome: "discharged",
        },
        { database: ctx.db },
      );

      await saveClinicalNote(noteInput(fixture, visit, { sign: true }), { database: ctx.db });
      const recorded = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icd.code,
          isPrimary: true,
        },
        { database: ctx.db },
      );
      const voided = await recordDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          icd10Code: fixture.icdOther.code,
        },
        { database: ctx.db },
      );
      await voidDiagnosis(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          diagnosisId: voided.diagnosisId,
        },
        { database: ctx.db },
      );

      const order = await orderLabTests(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labTestIds: [fixture.labTest.id],
          clinicalNotes: "Baseline haemoglobin",
        },
        { database: ctx.db },
      );
      await ctx.db.insert(labResults).values({
        id: newId(),
        facilityId: fixture.facility.id,
        labOrderItemId: order.itemIds[0],
        parameter: "Haemoglobin",
        value: "10.2",
        unit: "g/dL",
        refRange: "12.0 - 17.0",
        flag: "L",
        enteredBy: "lab-tech",
        verifiedBy: "lab-supervisor",
        verifiedAt: new Date(),
        createdBy: "lab-tech",
      });

      await prescribe(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          itemId: fixture.drug.id,
          dose: "1 tablet",
          route: "oral",
          frequency: "twice daily",
          durationDays: 3,
          quantity: 6,
        },
        { database: ctx.db },
      );

      const detail = await getEncounterClinicalDetail(ctx.db, fixture.facility.id, visit.encounterId);
      expect(detail).not.toBeNull();
      if (!detail) throw new Error("Expected a clinical detail");

      expect(detail.patient).toMatchObject({
        id: visit.patientId,
        encounterId: visit.encounterId,
        encounterNo: visit.encounterNo,
        mrn: visit.mrn,
        firstName: "Amina",
        lastName: "Otieno",
        sex: "female",
        allergies: ["Penicillin"],
        bloodGroup: "O+",
        status: "open",
      });

      expect(detail.vitals).toMatchObject({
        category: "green",
        chiefComplaint: "Headache for two days",
        comments: "No red flags",
        nextSteps: "Doctor review",
        systolic: 118,
        diastolic: 76,
        bmi: "23.5",
      });
      expect(detail.note).toMatchObject({
        assessment: "Tension-type headache",
        plan: "Paracetamol, review in three days",
      });
      expect(detail.note?.signedAt).not.toBeNull();

      expect(detail.diagnoses).toHaveLength(1);
      expect(detail.diagnoses[0]).toMatchObject({
        id: recorded.diagnosisId,
        code: fixture.icd.code,
        description: fixture.icd.description,
        isPrimary: true,
      });

      expect(detail.labOrders).toHaveLength(1);
      expect(detail.labOrders[0]).toMatchObject({
        id: order.labOrderId,
        status: "ordered",
        clinicalNotes: "Baseline haemoglobin",
      });
      expect(detail.labOrders[0].items).toHaveLength(1);
      expect(detail.labOrders[0].items[0]).toMatchObject({
        labTestId: fixture.labTest.id,
        testCode: fixture.labTest.code,
        testName: fixture.labTest.name,
      });
      expect(detail.labOrders[0].items[0].results).toHaveLength(1);
      expect(detail.labOrders[0].items[0].results[0]).toMatchObject({
        parameter: "Haemoglobin",
        value: "10.2",
        unit: "g/dL",
        flag: "L",
        enteredBy: "lab-tech",
        verifiedBy: "lab-supervisor",
      });

      expect(detail.prescriptions).toHaveLength(1);
      expect(detail.prescriptions[0]).toMatchObject({
        itemId: fixture.drug.id,
        itemName: fixture.drug.name,
        dose: "1 tablet",
        route: "oral",
        frequency: "twice daily",
        durationDays: 3,
        quantity: 6,
        status: "prescribed",
      });

      expect(detail.history).toHaveLength(1);
      expect(detail.history[0]).toMatchObject({
        id: previous.encounterId,
        encounterNo: previous.encounterNo,
        status: "discharged",
        assessment: "Malaria",
        plan: "Artemether-lumefantrine",
      });
      expect(detail.history[0].diagnoses).toEqual([
        {
          code: fixture.icdOther.code,
          description: fixture.icdOther.description,
          isPrimary: true,
        },
      ]);
    });
  });

  it("returns null for another facility's encounter", async () => {
    await withClinicalFacility(async (fixture) => {
      const visit = await createDoctorVisit(fixture);
      const other = await insertTestFacility(ctx.db);
      try {
        await expect(
          getEncounterClinicalDetail(ctx.db, other.id, visit.encounterId),
        ).resolves.toBeNull();
      } finally {
        await cleanupTestFacility(ctx.db, other.id);
      }
    });
  });
});

describe("clinical catalogue queries", () => {
  it("searches ICD-10 by code prefix and description substring", async () => {
    await withClinicalFacility(async (fixture) => {
      const byCode = await searchIcd10(ctx.db, fixture.icd.code.slice(0, 3));
      expect(byCode.some((entry) => entry.code === fixture.icd.code)).toBe(true);

      const byDescription = await searchIcd10(ctx.db, "condition alpha");
      expect(byDescription.some((entry) => entry.code === fixture.icd.code)).toBe(true);

      const wildcard = await searchIcd10(ctx.db, "%");
      expect(wildcard.some((entry) => entry.code === fixture.icd.code)).toBe(false);
    });
  });

  it("lists facility and shared lab tests", async () => {
    await withClinicalFacility(async (fixture) => {
      const sharedId = newId();
      await ctx.db.insert(labTests).values({
        id: sharedId,
        facilityId: null,
        code: `SHR${fixture.suffix}`,
        name: `Shared test ${fixture.suffix}`,
        sampleType: "Serum",
        parameters: [],
        createdBy: "vitest",
      });

      try {
        const tests = await listLabTests(ctx.db, fixture.facility.id);
        expect(tests.map((test) => test.id)).toEqual(
          expect.arrayContaining([fixture.labTest.id, fixture.otherLabTest.id, sharedId]),
        );
      } finally {
        await ctx.db.delete(labTests).where(eq(labTests.id, sharedId));
      }
    });
  });

  it("lists only drug items from the facility and shared catalogue", async () => {
    await withClinicalFacility(async (fixture) => {
      const drugs = await listDrugs(ctx.db, fixture.facility.id);
      expect(drugs.map((item) => item.id)).toContain(fixture.drug.id);
      expect(drugs.map((item) => item.id)).not.toContain(fixture.consumable.id);
    });
  });
});
