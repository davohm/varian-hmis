import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
  clinicalNotes,
  diagnoses,
  encounters,
  icd10Codes,
  items,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  patients,
  prescriptions,
  triageVitals,
} from "@/server/db/schema";

export type ClinicalDatabase = typeof db;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface Icd10Option {
  code: string;
  description: string;
  chapter: string | null;
}

/** ICD-10 picker search: code prefix or description substring, alphabetically stable. */
export async function searchIcd10(
  database: ClinicalDatabase,
  query: string,
  limit = 12,
): Promise<Icd10Option[]> {
  const term = query.trim();
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);

  if (!term) {
    return database
      .select({ code: icd10Codes.code, description: icd10Codes.description, chapter: icd10Codes.chapter })
      .from(icd10Codes)
      .orderBy(asc(icd10Codes.code))
      .limit(safeLimit);
  }

  const escaped = escapeLike(term);
  return database
    .select({ code: icd10Codes.code, description: icd10Codes.description, chapter: icd10Codes.chapter })
    .from(icd10Codes)
    .where(
      or(
        sql`${icd10Codes.code} ILIKE ${`${escaped}%`} ESCAPE '\\'`,
        sql`${icd10Codes.description} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
      ),
    )
    .orderBy(asc(icd10Codes.code))
    .limit(safeLimit);
}

export interface LabTestOption {
  id: string;
  code: string;
  name: string;
  sampleType: string;
  parameters: Array<{
    name: string;
    unit: string;
    refLow: number | null;
    refHigh: number | null;
    criticalLow: number | null;
    criticalHigh: number | null;
  }>;
}

/** Facility tests plus shared (facility_id is null) catalogue rows. */
export async function listLabTests(
  database: ClinicalDatabase,
  facilityId: string,
): Promise<LabTestOption[]> {
  return database
    .select({
      id: labTests.id,
      code: labTests.code,
      name: labTests.name,
      sampleType: labTests.sampleType,
      parameters: labTests.parameters,
    })
    .from(labTests)
    .where(or(isNull(labTests.facilityId), eq(labTests.facilityId, facilityId)))
    .orderBy(asc(labTests.name));
}

export interface DrugOption {
  id: string;
  code: string;
  name: string;
  unit: string;
  strength: string | null;
  form: string | null;
}

export async function listDrugs(
  database: ClinicalDatabase,
  facilityId: string,
): Promise<DrugOption[]> {
  return database
    .select({
      id: items.id,
      code: items.code,
      name: items.name,
      unit: items.unit,
      strength: items.strength,
      form: items.form,
    })
    .from(items)
    .where(
      and(eq(items.kind, "drug"), or(isNull(items.facilityId), eq(items.facilityId, facilityId))),
    )
    .orderBy(asc(items.name));
}

export interface EncounterPatient {
  id: string;
  encounterId: string;
  encounterNo: string;
  status: string;
  payerType: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  mrn: string;
  firstName: string;
  lastName: string;
  sex: string;
  dob: string | null;
  allergies: string[];
  bloodGroup: string | null;
  patientPayerType: string;
}

export interface TriageSummary {
  id: string;
  category: string;
  chiefComplaint: string;
  comments: string | null;
  nextSteps: string | null;
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  respRate: number | null;
  temperature: string | null;
  spo2: number | null;
  weightKg: string | null;
  heightCm: string | null;
  bmi: string | null;
  painScore: number | null;
  muacCm: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface ClinicalNoteView {
  id: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  authorId: string;
  signedAt: string | null;
  updatedAt: string;
}

export interface DiagnosisView {
  id: string;
  code: string;
  description: string;
  isPrimary: boolean;
  diagnosedBy: string;
  createdAt: string;
}

export interface LabResultView {
  id: string;
  parameter: string;
  value: string;
  unit: string | null;
  refRange: string | null;
  flag: string;
  enteredBy: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface LabOrderItemView {
  id: string;
  labTestId: string;
  testCode: string;
  testName: string;
  sampleType: string;
  status: string;
  results: LabResultView[];
}

export interface LabOrderView {
  id: string;
  status: string;
  clinicalNotes: string | null;
  orderedBy: string;
  sampleId: string | null;
  collectedAt: string | null;
  createdAt: string;
  items: LabOrderItemView[];
}

export interface PrescriptionView {
  id: string;
  itemId: string;
  itemName: string;
  strength: string | null;
  form: string | null;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number;
  instructions: string | null;
  status: string;
  prescribedBy: string;
  cancelledAt: string | null;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  encounterNo: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  diagnoses: Array<{ code: string; description: string; isPrimary: boolean }>;
  assessment: string | null;
  plan: string | null;
}

export interface EncounterClinicalDetail {
  patient: EncounterPatient;
  vitals: TriageSummary | null;
  note: ClinicalNoteView | null;
  diagnoses: DiagnosisView[];
  labOrders: LabOrderView[];
  prescriptions: PrescriptionView[];
  history: HistoryEntry[];
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Everything the doctor screen needs for one encounter: the pinned banner,
 * triage observations, SOAP note, diagnoses, orders with results,
 * prescriptions and the patient's previous closed visits.
 */
export async function getEncounterClinicalDetail(
  database: ClinicalDatabase,
  facilityId: string,
  encounterId: string,
): Promise<EncounterClinicalDetail | null> {
  const encounterRows = await database
    .select({
      id: encounters.id,
      encounterNo: encounters.encounterNo,
      status: encounters.status,
      payerType: encounters.payerType,
      startedAt: encounters.startedAt,
      endedAt: encounters.endedAt,
      outcome: encounters.outcome,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      sex: patients.sex,
      dob: patients.dob,
      allergies: patients.allergies,
      bloodGroup: patients.bloodGroup,
      patientPayerType: patients.payerType,
    })
    .from(encounters)
    .innerJoin(
      patients,
      and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)),
    )
    .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)))
    .limit(1);
  const encounter = encounterRows[0];
  if (!encounter) return null;

  const vitalsRows = await database
    .select()
    .from(triageVitals)
    .where(
      and(eq(triageVitals.facilityId, facilityId), eq(triageVitals.encounterId, encounter.id)),
    )
    .orderBy(desc(triageVitals.createdAt))
    .limit(1);
  const vitals = vitalsRows[0];

  const noteRows = await database
    .select()
    .from(clinicalNotes)
    .where(
      and(eq(clinicalNotes.facilityId, facilityId), eq(clinicalNotes.encounterId, encounter.id)),
    )
    .orderBy(desc(clinicalNotes.createdAt))
    .limit(1);
  const note = noteRows[0];

  const diagnosisRows = await database
    .select()
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.facilityId, facilityId),
        eq(diagnoses.encounterId, encounter.id),
        isNull(diagnoses.voidedAt),
      ),
    )
    .orderBy(desc(diagnoses.isPrimary), asc(diagnoses.createdAt));

  const orderRows = await database
    .select()
    .from(labOrders)
    .where(and(eq(labOrders.facilityId, facilityId), eq(labOrders.encounterId, encounter.id)))
    .orderBy(desc(labOrders.createdAt));

  const orderIds = orderRows.map((order) => order.id);
  const itemRows = orderIds.length
    ? await database
        .select({
          id: labOrderItems.id,
          labOrderId: labOrderItems.labOrderId,
          labTestId: labOrderItems.labTestId,
          status: labOrderItems.status,
          testCode: labTests.code,
          testName: labTests.name,
          sampleType: labTests.sampleType,
        })
        .from(labOrderItems)
        .innerJoin(labTests, eq(labTests.id, labOrderItems.labTestId))
        .where(
          and(
            eq(labOrderItems.facilityId, facilityId),
            inArray(labOrderItems.labOrderId, orderIds),
          ),
        )
        .orderBy(asc(labOrderItems.createdAt))
    : [];

  const itemIds = itemRows.map((item) => item.id);
  const resultRows = itemIds.length
    ? await database
        .select()
        .from(labResults)
        .where(
          and(eq(labResults.facilityId, facilityId), inArray(labResults.labOrderItemId, itemIds)),
        )
        .orderBy(asc(labResults.createdAt))
    : [];

  const resultsByItem = new Map<string, LabResultView[]>();
  for (const result of resultRows) {
    const list = resultsByItem.get(result.labOrderItemId) ?? [];
    list.push({
      id: result.id,
      parameter: result.parameter,
      value: result.value,
      unit: result.unit,
      refRange: result.refRange,
      flag: result.flag,
      enteredBy: result.enteredBy,
      verifiedBy: result.verifiedBy,
      verifiedAt: iso(result.verifiedAt),
    });
    resultsByItem.set(result.labOrderItemId, list);
  }

  const itemsByOrder = new Map<string, LabOrderItemView[]>();
  for (const item of itemRows) {
    const list = itemsByOrder.get(item.labOrderId) ?? [];
    list.push({
      id: item.id,
      labTestId: item.labTestId,
      testCode: item.testCode,
      testName: item.testName,
      sampleType: item.sampleType,
      status: item.status,
      results: resultsByItem.get(item.id) ?? [],
    });
    itemsByOrder.set(item.labOrderId, list);
  }

  const prescriptionRows = await database
    .select({
      id: prescriptions.id,
      itemId: prescriptions.itemId,
      itemName: items.name,
      strength: items.strength,
      form: items.form,
      dose: prescriptions.dose,
      route: prescriptions.route,
      frequency: prescriptions.frequency,
      durationDays: prescriptions.durationDays,
      quantity: prescriptions.quantity,
      instructions: prescriptions.instructions,
      status: prescriptions.status,
      prescribedBy: prescriptions.prescribedBy,
      cancelledAt: prescriptions.cancelledAt,
      createdAt: prescriptions.createdAt,
    })
    .from(prescriptions)
    .innerJoin(items, eq(items.id, prescriptions.itemId))
    .where(
      and(
        eq(prescriptions.facilityId, facilityId),
        eq(prescriptions.encounterId, encounter.id),
      ),
    )
    .orderBy(desc(prescriptions.createdAt));

  const historyRows = await database
    .select({
      id: encounters.id,
      encounterNo: encounters.encounterNo,
      status: encounters.status,
      startedAt: encounters.startedAt,
      endedAt: encounters.endedAt,
      outcome: encounters.outcome,
    })
    .from(encounters)
    .where(
      and(
        eq(encounters.facilityId, facilityId),
        eq(encounters.patientId, encounter.patientId),
        ne(encounters.id, encounter.id),
        inArray(encounters.status, ["discharged", "referred"]),
      ),
    )
    .orderBy(desc(encounters.startedAt))
    .limit(10);

  const historyIds = historyRows.map((row) => row.id);
  const historyDiagnoses = historyIds.length
    ? await database
        .select({
          encounterId: diagnoses.encounterId,
          code: diagnoses.icd10Code,
          description: diagnoses.description,
          isPrimary: diagnoses.isPrimary,
        })
        .from(diagnoses)
        .where(
          and(
            eq(diagnoses.facilityId, facilityId),
            inArray(diagnoses.encounterId, historyIds),
            isNull(diagnoses.voidedAt),
          ),
        )
        .orderBy(desc(diagnoses.isPrimary), asc(diagnoses.createdAt))
    : [];

  const historyNotes = historyIds.length
    ? await database
        .select({
          encounterId: clinicalNotes.encounterId,
          assessment: clinicalNotes.assessment,
          plan: clinicalNotes.plan,
        })
        .from(clinicalNotes)
        .where(
          and(
            eq(clinicalNotes.facilityId, facilityId),
            inArray(clinicalNotes.encounterId, historyIds),
          ),
        )
        .orderBy(desc(clinicalNotes.createdAt))
    : [];

  const diagnosesByEncounter = new Map<
    string,
    Array<{ code: string; description: string; isPrimary: boolean }>
  >();
  for (const diagnosis of historyDiagnoses) {
    const list = diagnosesByEncounter.get(diagnosis.encounterId) ?? [];
    list.push({
      code: diagnosis.code,
      description: diagnosis.description,
      isPrimary: diagnosis.isPrimary,
    });
    diagnosesByEncounter.set(diagnosis.encounterId, list);
  }

  const noteByEncounter = new Map<string, { assessment: string | null; plan: string | null }>();
  for (const historyNote of historyNotes) {
    if (!noteByEncounter.has(historyNote.encounterId)) {
      noteByEncounter.set(historyNote.encounterId, {
        assessment: historyNote.assessment,
        plan: historyNote.plan,
      });
    }
  }

  return {
    patient: {
      id: encounter.patientId,
      encounterId: encounter.id,
      encounterNo: encounter.encounterNo,
      status: encounter.status,
      payerType: encounter.payerType,
      startedAt: iso(encounter.startedAt) ?? "",
      endedAt: iso(encounter.endedAt),
      outcome: encounter.outcome,
      mrn: encounter.mrn,
      firstName: encounter.firstName,
      lastName: encounter.lastName,
      sex: encounter.sex,
      dob: encounter.dob,
      allergies: encounter.allergies ?? [],
      bloodGroup: encounter.bloodGroup,
      patientPayerType: encounter.patientPayerType,
    },
    vitals: vitals
      ? {
          id: vitals.id,
          category: vitals.category,
          chiefComplaint: vitals.chiefComplaint,
          comments: vitals.comments,
          nextSteps: vitals.nextSteps,
          systolic: vitals.systolic,
          diastolic: vitals.diastolic,
          heartRate: vitals.heartRate,
          respRate: vitals.respRate,
          temperature: vitals.temperature,
          spo2: vitals.spo2,
          weightKg: vitals.weightKg,
          heightCm: vitals.heightCm,
          bmi: vitals.bmi,
          painScore: vitals.painScore,
          muacCm: vitals.muacCm,
          recordedBy: vitals.recordedBy,
          createdAt: iso(vitals.createdAt) ?? "",
        }
      : null,
    note: note
      ? {
          id: note.id,
          subjective: note.subjective,
          objective: note.objective,
          assessment: note.assessment,
          plan: note.plan,
          authorId: note.authorId,
          signedAt: iso(note.signedAt),
          updatedAt: iso(note.updatedAt) ?? "",
        }
      : null,
    diagnoses: diagnosisRows.map((diagnosis) => ({
      id: diagnosis.id,
      code: diagnosis.icd10Code,
      description: diagnosis.description,
      isPrimary: diagnosis.isPrimary,
      diagnosedBy: diagnosis.diagnosedBy,
      createdAt: iso(diagnosis.createdAt) ?? "",
    })),
    labOrders: orderRows.map((order) => ({
      id: order.id,
      status: order.status,
      clinicalNotes: order.clinicalNotes,
      orderedBy: order.orderedBy,
      sampleId: order.sampleId,
      collectedAt: iso(order.collectedAt),
      createdAt: iso(order.createdAt) ?? "",
      items: itemsByOrder.get(order.id) ?? [],
    })),
    prescriptions: prescriptionRows.map((prescription) => ({
      ...prescription,
      cancelledAt: iso(prescription.cancelledAt),
      createdAt: iso(prescription.createdAt) ?? "",
    })),
    history: historyRows.map((row) => {
      const entryNote = noteByEncounter.get(row.id);
      return {
        id: row.id,
        encounterNo: row.encounterNo,
        status: row.status,
        startedAt: iso(row.startedAt) ?? "",
        endedAt: iso(row.endedAt),
        outcome: row.outcome,
        diagnoses: diagnosesByEncounter.get(row.id) ?? [],
        assessment: entryNote?.assessment ?? null,
        plan: entryNote?.plan ?? null,
      };
    }),
  };
}
