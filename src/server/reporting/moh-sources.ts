import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import {
  eyeAgeBand,
  normalizeEyeDiagnosisCode,
  normalizeEyeVisualAcuity,
  normalizeImmunizationDoseCode,
  normalizeMoh710BAntigen,
} from "@/lib/moh-reporting";
import type { db } from "@/server/db/client";
import {
  branches,
  eyeAssessments,
  facilitySettings,
  immunizations,
  items,
  patients,
  queueEntries,
  stockLedger,
  stores,
} from "@/server/db/schema";

export type MohSourceDb = typeof db;

export interface MohPeriodInput {
  facilityId: string;
  branchId?: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface MohDoseEvent {
  id: string;
  patientId: string;
  encounterId: string | null;
  rawDoseCode: string;
  rawAntigenCode: string;
  doseCode: string | null;
  antigen: string | null;
  administeredAt: Date;
  itemId: string | null;
  batchId: string | null;
  dob: string | null;
  sex: string;
}

export interface MohStockEvent {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  antigen: string | null;
  reason: string;
  qtyDelta: number;
  createdAt: Date;
  storeId: string;
  branchId: string;
  batchId: string | null;
}

export interface MohEyeEvent {
  id: string;
  patientId: string;
  encounterId: string;
  branchId: string;
  branchName: string;
  mrn: string;
  patientName: string;
  dob: string | null;
  sex: string;
  payerType: string;
  age: number;
  ageBand: "lt5" | "5_15" | "ge16";
  visitedAt: Date;
  visitType: string;
  visualAcuity: "normal" | "low_vision" | "blind";
  vaRight: string | null;
  vaLeft: string | null;
  disabilityType: string | null;
  diagnosisCode: string;
  normalizedDiagnosis: string;
  impression: string | null;
  management: string | null;
  referral: string | null;
  county: string | null;
  residence: string | null;
  phone: string | null;
  registeredBy: string | null;
  seenBy: string;
  timeRegistered: Date | null;
  timeSeen: Date | null;
  lastStage: string;
  admittedAt: Date | null;
  dischargedAt: Date | null;
}

export interface MohQueueEvent {
  id: string;
  encounterId: string;
  status: string;
  createdAt: Date;
}

export interface MohSources {
  doses: MohDoseEvent[];
  stock: MohStockEvent[];
  eyes: MohEyeEvent[];
  queues: MohQueueEvent[];
  /** Admin-entered reporting setting; zero when the facility has not set it. */
  eyeWardBeds: number;
}

export function periodBounds(input: MohPeriodInput) {
  return {
    start: new Date(`${input.periodStart}T00:00:00.000Z`),
    end: new Date(`${input.periodEnd}T23:59:59.999Z`),
  };
}

export function dayKeyOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `d${date.toISOString().slice(8, 10)}`;
}

export function ageAtOn(dob: string | null | undefined, ref: Date): number {
  if (!dob) return 999;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return 999;
  let age = ref.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = ref.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && ref.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

export async function fetchImmunizationEvents(database: MohSourceDb, input: MohPeriodInput): Promise<MohDoseEvent[]> {
  const { start, end } = periodBounds(input);
  const conditions = [
    eq(immunizations.facilityId, input.facilityId),
    eq(immunizations.status, "administered"),
    gte(immunizations.administeredAt, start),
    lte(immunizations.administeredAt, end),
    ...(input.branchId ? [eq(immunizations.branchId, input.branchId)] : []),
  ];
  const rows = await database
    .select({
      id: immunizations.id,
      patientId: immunizations.patientId,
      encounterId: immunizations.encounterId,
      rawDoseCode: immunizations.doseCode,
      rawAntigenCode: immunizations.antigenCode,
      administeredAt: immunizations.administeredAt,
      itemId: immunizations.itemId,
      batchId: immunizations.batchId,
      dob: patients.dob,
      sex: patients.sex,
    })
    .from(immunizations)
    .innerJoin(patients, eq(patients.id, immunizations.patientId))
    .where(and(...conditions))
    .orderBy(asc(immunizations.administeredAt));

  return rows.map((row) => ({
    ...row,
    doseCode: normalizeImmunizationDoseCode(row.rawDoseCode) ?? normalizeImmunizationDoseCode(row.rawAntigenCode),
    antigen:
      normalizeMoh710BAntigen(row.rawDoseCode) ??
      normalizeMoh710BAntigen(row.rawAntigenCode),
    sex: row.sex === "male" ? "male" : row.sex === "female" ? "female" : "other",
  }));
}

export async function fetchStockEvents(database: MohSourceDb, input: MohPeriodInput): Promise<MohStockEvent[]> {
  const { end } = periodBounds(input);
  const rows = await database
    .select({
      id: stockLedger.id,
      itemId: stockLedger.itemId,
      itemCode: items.code,
      itemName: items.name,
      reason: stockLedger.reason,
      qtyDelta: stockLedger.qtyDelta,
      createdAt: stockLedger.createdAt,
      storeId: stockLedger.storeId,
      branchId: stores.branchId,
      batchId: stockLedger.batchId,
    })
    .from(stockLedger)
    .innerJoin(items, eq(items.id, stockLedger.itemId))
    .innerJoin(stores, eq(stores.id, stockLedger.storeId))
    .where(
      and(
        eq(stockLedger.facilityId, input.facilityId),
        lte(stockLedger.createdAt, end),
        ...(input.branchId ? [eq(stores.branchId, input.branchId)] : []),
      ),
    )
    .orderBy(asc(stockLedger.createdAt));

  return rows.map((row) => ({
    ...row,
    qtyDelta: Number(row.qtyDelta),
    antigen: normalizeMoh710BAntigen(row.itemCode) ?? normalizeMoh710BAntigen(row.itemName),
  }));
}

export async function fetchEyeEvents(database: MohSourceDb, input: MohPeriodInput): Promise<MohEyeEvent[]> {
  const { start, end } = periodBounds(input);
  const rows = await database
    .select({
      id: eyeAssessments.id,
      patientId: eyeAssessments.patientId,
      encounterId: eyeAssessments.encounterId,
      branchId: eyeAssessments.branchId,
      branchName: branches.name,
      mrn: patients.mrn,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dob,
      sex: patients.sex,
      payerType: patients.payerType,
      visitedAt: eyeAssessments.visitedAt,
      visitType: eyeAssessments.visitType,
      visualAcuity: eyeAssessments.visualAcuity,
      vaRight: eyeAssessments.vaRight,
      vaLeft: eyeAssessments.vaLeft,
      disabilityType: eyeAssessments.disabilityType,
      diagnosisCode: eyeAssessments.diagnosisCode,
      impression: eyeAssessments.impression,
      management: eyeAssessments.management,
      referral: eyeAssessments.referral,
      county: eyeAssessments.county,
      residence: eyeAssessments.residence,
      phone: eyeAssessments.phone,
      registeredBy: eyeAssessments.registeredBy,
      seenBy: eyeAssessments.seenBy,
      timeRegistered: eyeAssessments.timeRegistered,
      timeSeen: eyeAssessments.timeSeen,
      lastStage: eyeAssessments.lastStage,
      admittedAt: eyeAssessments.admittedAt,
      dischargedAt: eyeAssessments.dischargedAt,
    })
    .from(eyeAssessments)
    .innerJoin(patients, eq(patients.id, eyeAssessments.patientId))
    .leftJoin(branches, eq(branches.id, eyeAssessments.branchId))
    .where(
      and(
        eq(eyeAssessments.facilityId, input.facilityId),
        gte(eyeAssessments.visitedAt, start),
        lte(eyeAssessments.visitedAt, end),
        ...(input.branchId ? [eq(eyeAssessments.branchId, input.branchId)] : []),
      ),
    )
    .orderBy(asc(eyeAssessments.visitedAt));

  return rows.map((row) => {
    const age = ageAtOn(row.dob, row.visitedAt);
    return {
      id: row.id,
      patientId: row.patientId,
      encounterId: row.encounterId,
      branchId: row.branchId,
      branchName: row.branchName ?? "Unknown branch",
      mrn: row.mrn,
      patientName: `${row.firstName} ${row.lastName}`.trim(),
      dob: row.dob,
      sex: row.sex === "male" ? "male" : row.sex === "female" ? "female" : "other",
      payerType: row.payerType,
      age,
      ageBand: eyeAgeBand(age),
      visitedAt: row.visitedAt,
      visitType: row.visitType,
      visualAcuity:
        normalizeEyeVisualAcuity(row.vaRight) ??
        normalizeEyeVisualAcuity(row.vaLeft) ??
        (row.visualAcuity as "normal" | "low_vision" | "blind"),
      vaRight: row.vaRight,
      vaLeft: row.vaLeft,
      disabilityType: row.disabilityType,
      diagnosisCode: row.diagnosisCode,
      normalizedDiagnosis: normalizeEyeDiagnosisCode(row.diagnosisCode) ?? "other",
      impression: row.impression,
      management: row.management,
      referral: row.referral,
      county: row.county,
      residence: row.residence,
      phone: row.phone,
      registeredBy: row.registeredBy,
      seenBy: row.seenBy ?? "Unassigned",
      timeRegistered: row.timeRegistered,
      timeSeen: row.timeSeen,
      lastStage: row.lastStage ?? "done",
      admittedAt: row.admittedAt,
      dischargedAt: row.dischargedAt,
    };
  });
}

export async function fetchQueueEvents(
  database: MohSourceDb,
  input: MohPeriodInput,
  encounterIds: string[],
): Promise<MohQueueEvent[]> {
  if (encounterIds.length === 0) return [];
  return database
    .select({ id: queueEntries.id, encounterId: queueEntries.encounterId, status: queueEntries.status, createdAt: queueEntries.queuedAt })
    .from(queueEntries)
    .where(and(eq(queueEntries.facilityId, input.facilityId), inArray(queueEntries.encounterId, encounterIds)))
    .orderBy(asc(queueEntries.queuedAt));
}

/** Unconfirmed regulator values stay admin-entered; zero means "not configured". */
export async function getReportingNumericSetting(
  database: MohSourceDb,
  facilityId: string,
  key: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const [row] = await database
    .select({ valueNumeric: facilitySettings.valueNumeric })
    .from(facilitySettings)
    .where(
      and(
        eq(facilitySettings.facilityId, facilityId),
        eq(facilitySettings.domain, "reporting"),
        eq(facilitySettings.key, key),
        lte(facilitySettings.effectiveFrom, periodStart),
        or(isNull(facilitySettings.effectiveTo), gte(facilitySettings.effectiveTo, periodEnd)),
      ),
    )
    .orderBy(desc(facilitySettings.effectiveFrom))
    .limit(1);
  return row?.valueNumeric == null ? 0 : Number(row.valueNumeric);
}

export async function fetchMohSources(database: MohSourceDb, input: MohPeriodInput): Promise<MohSources> {
  const eyes = await fetchEyeEvents(database, input);
  const [doses, stock, eyeWardBeds] = await Promise.all([
    fetchImmunizationEvents(database, input),
    fetchStockEvents(database, input),
    getReportingNumericSetting(database, input.facilityId, "eye_ward_beds", input.periodStart, input.periodEnd),
  ]);
  const queues = await fetchQueueEvents(
    database,
    input,
    Array.from(new Set(eyes.map((eye) => eye.encounterId))),
  );
  return { doses, stock, eyes, queues, eyeWardBeds };
}

export function doseMatchesMoh710ACell(event: MohDoseEvent, rowCode: string, colKey: string) {
  if (event.doseCode !== rowCode) return false;
  return colKey === "total" || dayKeyOf(event.administeredAt) === colKey;
}

export function stockMatchesMoh710BCell(
  event: MohStockEvent,
  antigen: string,
  suffix: string,
  input: MohPeriodInput,
) {
  if (event.antigen !== antigen) return false;
  const { start, end } = periodBounds(input);
  const inPeriod = event.createdAt >= start && event.createdAt <= end;
  if (suffix === "A") return event.createdAt < start;
  if (suffix === "B") {
    return inPeriod && event.qtyDelta > 0 && (event.reason === "receive" || event.reason === "transfer_in");
  }
  if (suffix === "G") return inPeriod && event.reason === "adjust" && event.qtyDelta < 0;
  return false;
}

export function doseMatchesMoh710BCell(event: MohDoseEvent, antigen: string) {
  return event.antigen === antigen;
}

const ACUITY_COL = /^(normal|lv|blind)_(lt5|5_15|ge16)_(m|f)$/;
const WORKLOAD_COL = /^(lt5|5_15|ge16)_(new|rev)_(m|f)$/;
const AGE_ROW = /^(lt5|5_15|ge16)_(new|revisit)_(m|f)$/;

function sexMatches(sex: string, code: string) {
  return sex === (code === "m" ? "male" : code === "f" ? "female" : sex);
}

function acuityMatches(event: MohEyeEvent, acuity: string) {
  return acuity === "normal"
    ? event.visualAcuity === "normal"
    : acuity === "lv"
      ? event.visualAcuity === "low_vision"
      : event.visualAcuity === "blind";
}

export function eyeMatchesMoh735Cell(event: MohEyeEvent, section: string, rowCode: string, colKey: string) {
  if (section === "A") {
    const match = WORKLOAD_COL.exec(colKey);
    if (!match) return false;
    const [, age, visit, sex] = match;
    if (event.ageBand !== age || !sexMatches(event.sex, sex)) return false;
    return visit === "new" ? event.visitType === "new" : event.visitType === "revisit";
  }
  if (section === "B") {
    if (colKey === "lv_m" || colKey === "lv_f") {
      return event.visualAcuity === "low_vision" && sexMatches(event.sex, colKey.slice(-1));
    }
    if (colKey === "blind_m" || colKey === "blind_f") {
      return event.visualAcuity === "blind" && sexMatches(event.sex, colKey.slice(-1));
    }
    return false;
  }
  if (section === "D") {
    if (event.normalizedDiagnosis !== rowCode) return false;
    const match = ACUITY_COL.exec(colKey);
    if (!match) return false;
    const [, acuity, age, sex] = match;
    return acuityMatches(event, acuity) && event.ageBand === age && sexMatches(event.sex, sex);
  }
  return false;
}

export function eyeMatchesMoh416Cell(event: MohEyeEvent, section: string, rowCode: string) {
  switch (section) {
    case "REGISTER":
      return event.id === rowCode;
    case "SUMMARY":
      return rowCode === "total_seen" || rowCode === "net_seen";
    case "DEPTS":
      return event.visitType === rowCode;
    case "DOCTORS":
      return event.seenBy === rowCode;
    case "DIAGNOSIS":
      return event.normalizedDiagnosis === rowCode;
    case "RESIDENCY":
    case "BRANCHES":
      return event.branchName === rowCode;
    case "AGE": {
      const match = AGE_ROW.exec(rowCode);
      if (!match) return false;
      const [, age, visit, sex] = match;
      if (event.ageBand !== age || !sexMatches(event.sex, sex)) return false;
      return visit === "new" ? event.visitType === "new" : event.visitType === "revisit";
    }
    case "VISUAL_ACUITY": {
      if (rowCode === "low_vision_m" || rowCode === "low_vision_f") {
        return event.visualAcuity === "low_vision" && sexMatches(event.sex, rowCode.slice(-1));
      }
      if (rowCode === "blind_m" || rowCode === "blind_f") {
        return event.visualAcuity === "blind" && sexMatches(event.sex, rowCode.slice(-1));
      }
      return false;
    }
    default:
      return false;
  }
}

export function isoOrNull(value: Date | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export function mapDoseSource(event: MohDoseEvent) {
  return {
    provenance: "immunizations",
    id: event.id,
    immunizationId: event.id,
    patientId: event.patientId,
    encounterId: event.encounterId,
    doseCode: event.doseCode,
    rawDoseCode: event.rawDoseCode,
    antigen: event.antigen,
    administeredAt: isoOrNull(event.administeredAt),
    itemId: event.itemId,
    batchId: event.batchId,
  };
}

export function mapStockSource(event: MohStockEvent) {
  return {
    provenance: "stock_ledger",
    id: event.id,
    stockLedgerId: event.id,
    itemId: event.itemId,
    itemCode: event.itemCode,
    itemName: event.itemName,
    antigen: event.antigen,
    reason: event.reason,
    qtyDelta: event.qtyDelta,
    createdAt: isoOrNull(event.createdAt),
    storeId: event.storeId,
    branchId: event.branchId,
    batchId: event.batchId,
  };
}

export function mapEyeSource(event: MohEyeEvent) {
  return {
    provenance: "eye_assessments",
    id: event.id,
    eyeAssessmentId: event.id,
    encounterId: event.encounterId,
    patientId: event.patientId,
    patientNo: event.mrn,
    patientName: event.patientName,
    age: event.age,
    ageBand: event.ageBand,
    sex: event.sex,
    payerType: event.payerType,
    branch: event.branchName,
    visitedAt: isoOrNull(event.visitedAt),
    visitType: event.visitType,
    visualAcuity: event.visualAcuity,
    vaRight: event.vaRight,
    vaLeft: event.vaLeft,
    disabilityType: event.disabilityType,
    diagnosisCode: event.diagnosisCode,
    impression: event.impression,
    management: event.management,
    referral: event.referral,
    county: event.county,
    residence: event.residence,
    phone: event.phone,
    registeredBy: event.registeredBy,
    seenBy: event.seenBy,
    timeRegistered: isoOrNull(event.timeRegistered),
    timeSeen: isoOrNull(event.timeSeen),
    lastStage: event.lastStage,
    admittedAt: isoOrNull(event.admittedAt),
    dischargedAt: isoOrNull(event.dischargedAt),
  };
}

export function mapQueueSource(event: MohQueueEvent) {
  return {
    provenance: "queue_entries",
    id: event.id,
    encounterId: event.encounterId,
    status: event.status,
    queuedAt: isoOrNull(event.createdAt),
  };
}

/** The exact operational rows that produce a generated MOH cell value. */
export function mohSourceRowsForCell(
  reportCode: "MOH710A" | "MOH710B" | "MOH735" | "MOH416",
  input: MohPeriodInput,
  cell: { section?: string | null; rowCode?: string | null; colKey?: string | null },
  sources: MohSources,
): Array<Record<string, unknown>> {
  const section = cell.section ?? "";
  const rowCode = cell.rowCode ?? "";
  const colKey = cell.colKey ?? "";

  if (reportCode === "MOH710A") {
    return sources.doses
      .filter((event) => doseMatchesMoh710ACell(event, rowCode, colKey))
      .map(mapDoseSource);
  }

  if (reportCode === "MOH710B") {
    const split = rowCode.lastIndexOf(":");
    if (split < 0) return [];
    const antigen = rowCode.slice(0, split);
    const suffix = rowCode.slice(split + 1);
    const stockRows = (suffixes: string[]) =>
      sources.stock
        .filter((event) => suffixes.some((s) => stockMatchesMoh710BCell(event, antigen, s, input)))
        .map(mapStockSource);
    const doseRows = sources.doses.filter((event) => doseMatchesMoh710BCell(event, antigen)).map(mapDoseSource);
    const distinctPatients = Array.from(new Map(doseRows.map((row) => [String(row.patientId), row])).values());
    if (suffix === "A" || suffix === "B" || suffix === "G") return stockRows([suffix]);
    if (suffix === "E") return doseRows;
    if (suffix === "F") return distinctPatients;
    if (suffix === "C" || suffix === "D") return [...stockRows(["A", "B", "G"]), ...doseRows];
    if (suffix === "H") return [...stockRows(["G"]), ...doseRows];
    return [];
  }

  if (reportCode === "MOH735") {
    if (section === "D" && colKey === "total") {
      return sources.eyes
        .filter((event) => event.normalizedDiagnosis === rowCode)
        .map(mapEyeSource);
    }
    if (section === "C") {
      const { start, end } = periodBounds(input);
      if (colKey === "beds") {
        return [{ provenance: "facility_settings", key: "reporting.eye_ward_beds", value: sources.eyeWardBeds, period: input.periodStart }];
      }
      if (colKey === "admissions") {
        return sources.eyes
          .filter((event) => event.admittedAt != null && event.admittedAt >= start && event.admittedAt <= end)
          .map(mapEyeSource);
      }
      if (colKey === "discharges") {
        return sources.eyes
          .filter((event) => event.dischargedAt != null && event.dischargedAt >= start && event.dischargedAt <= end)
          .map(mapEyeSource);
      }
      return [];
    }
    return sources.eyes
      .filter((event) => eyeMatchesMoh735Cell(event, section, rowCode, colKey))
      .map(mapEyeSource);
  }

  if (section === "QUEUE") {
    return sources.queues.filter((event) => event.status === rowCode).map(mapQueueSource);
  }
  if (section === "SUMMARY" && (colKey === "total_not_seen" || rowCode === "total_not_seen" || colKey === "direct_service" || rowCode === "direct_service")) {
    return [];
  }
  return sources.eyes
    .filter((event) => eyeMatchesMoh416Cell(event, section, rowCode))
    .map(mapEyeSource);
}
