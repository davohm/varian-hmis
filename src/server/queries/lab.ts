import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import {
  labStatusesForFilter,
  type LabWorklistFilter,
} from "@/lib/lab";
import { db } from "@/server/db/client";
import {
  encounters,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  patients,
} from "@/server/db/schema";
import type { LabParameter } from "@/server/db/schema/clinical";

export type LabDatabase = typeof db;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
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

export interface LabWorklistItem {
  id: string;
  labTestId: string;
  testCode: string;
  testName: string;
  sampleType: string;
  status: string;
  parameters: LabParameter[];
  results: LabResultView[];
}

export interface LabWorklistOrder {
  id: string;
  status: string;
  clinicalNotes: string | null;
  sampleId: string | null;
  collectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  encounterId: string;
  encounterNo: string;
  patientId: string;
  mrn: string;
  firstName: string;
  lastName: string;
  sex: string;
  dob: string | null;
  allergies: string[];
  payerType: string;
  items: LabWorklistItem[];
}

/**
 * The laboratory worklist: every order in the requested status group, with
 * the patient banner, test parameters and any entered results. Pending work
 * is ordered oldest first so nothing is starved.
 */
export async function getLabWorklist(
  database: LabDatabase,
  facilityId: string,
  filter: LabWorklistFilter = "pending",
  query = "",
  limit = 100,
): Promise<LabWorklistOrder[]> {
  const conditions: SQL[] = [eq(labOrders.facilityId, facilityId)];

  const statuses = labStatusesForFilter(filter);
  if (statuses) {
    conditions.push(inArray(labOrders.status, [...statuses]));
  }

  const term = query.trim();
  if (term) {
    const escaped = escapeLike(term);
    const search = or(
      sql`${patients.mrn} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
      sql`${patients.firstName} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
      sql`${patients.lastName} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
      sql`${encounters.encounterNo} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
      sql`${labOrders.sampleId} ILIKE ${`%${escaped}%`} ESCAPE '\\'`,
    );
    if (search) conditions.push(search);
  }

  const orderRows = await database
    .select({
      id: labOrders.id,
      status: labOrders.status,
      clinicalNotes: labOrders.clinicalNotes,
      sampleId: labOrders.sampleId,
      collectedAt: labOrders.collectedAt,
      createdAt: labOrders.createdAt,
      updatedAt: labOrders.updatedAt,
      encounterId: encounters.id,
      encounterNo: encounters.encounterNo,
      patientId: patients.id,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      sex: patients.sex,
      dob: patients.dob,
      allergies: patients.allergies,
      payerType: encounters.payerType,
    })
    .from(labOrders)
    .innerJoin(
      encounters,
      and(eq(encounters.id, labOrders.encounterId), eq(encounters.facilityId, labOrders.facilityId)),
    )
    .innerJoin(
      patients,
      and(eq(patients.id, encounters.patientId), eq(patients.facilityId, encounters.facilityId)),
    )
    .where(and(...conditions))
    .orderBy(asc(labOrders.createdAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 200));

  if (orderRows.length === 0) return [];

  const orderIds = orderRows.map((order) => order.id);
  const itemRows = await database
    .select({
      id: labOrderItems.id,
      labOrderId: labOrderItems.labOrderId,
      labTestId: labOrderItems.labTestId,
      status: labOrderItems.status,
      testCode: labTests.code,
      testName: labTests.name,
      sampleType: labTests.sampleType,
      parameters: labTests.parameters,
    })
    .from(labOrderItems)
    .innerJoin(labTests, eq(labTests.id, labOrderItems.labTestId))
    .where(
      and(
        eq(labOrderItems.facilityId, facilityId),
        inArray(labOrderItems.labOrderId, orderIds),
      ),
    )
    .orderBy(asc(labOrderItems.createdAt));

  const itemIds = itemRows.map((item) => item.id);
  const resultRows = itemIds.length
    ? await database
        .select()
        .from(labResults)
        .where(
          and(
            eq(labResults.facilityId, facilityId),
            inArray(labResults.labOrderItemId, itemIds),
          ),
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

  const itemsByOrder = new Map<string, LabWorklistItem[]>();
  for (const item of itemRows) {
    const list = itemsByOrder.get(item.labOrderId) ?? [];
    list.push({
      id: item.id,
      labTestId: item.labTestId,
      testCode: item.testCode,
      testName: item.testName,
      sampleType: item.sampleType,
      status: item.status,
      parameters: item.parameters ?? [],
      results: resultsByItem.get(item.id) ?? [],
    });
    itemsByOrder.set(item.labOrderId, list);
  }

  return orderRows.map((order) => ({
    id: order.id,
    status: order.status,
    clinicalNotes: order.clinicalNotes,
    sampleId: order.sampleId,
    collectedAt: iso(order.collectedAt),
    createdAt: iso(order.createdAt) ?? "",
    updatedAt: iso(order.updatedAt) ?? "",
    encounterId: order.encounterId,
    encounterNo: order.encounterNo,
    patientId: order.patientId,
    mrn: order.mrn,
    firstName: order.firstName,
    lastName: order.lastName,
    sex: order.sex,
    dob: iso(order.dob),
    allergies: order.allergies ?? [],
    payerType: order.payerType,
    items: itemsByOrder.get(order.id) ?? [],
  }));
}
