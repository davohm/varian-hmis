import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";

import { computeReportChecksum, getEpiWeek } from "@/lib/reporting";
import { MOH710B_ANTIGENS, emptyCellsFromTemplate, finalizeDailyTotals, moh505Template, moh710ATemplate, moh710BTemplate, moh416Template, moh735Template, moh717Template, moh705ATemplate, moh705BTemplate, setCell, type MohCell, type MohReportCode } from "@/lib/moh-reporting";
import type { db } from "@/server/db/client";
import { birthNotifications, deathNotifications, diagnoses, encounters, notifiableEvents, patients } from "@/server/db/schema";
import {
  dayKeyOf,
  doseMatchesMoh710BCell,
  eyeMatchesMoh416Cell,
  eyeMatchesMoh735Cell,
  fetchMohSources,
  isoOrNull,
  periodBounds,
  stockMatchesMoh710BCell,
} from "./moh-sources";

export type ReportingDb = typeof db;

export interface GenerateMohInput {
  facilityId: string;
  branchId?: string | null;
  reportCode: MohReportCode;
  periodStart: string;
  periodEnd: string;
  month: number;
  year: number;
  epiWeek?: number | null;
  epiYear?: number | null;
}

function dayKey(date: string) { return `d${date.slice(8, 10)}`; }

async function fetchOutpatientDiagnoses(database: ReportingDb, input: GenerateMohInput) {
  const conditions = [eq(encounters.facilityId, input.facilityId), gte(encounters.startedAt, new Date(`${input.periodStart}T00:00:00.000Z`)), lte(encounters.startedAt, new Date(`${input.periodEnd}T23:59:59.999Z`))];
  if (input.branchId) conditions.push(eq(encounters.branchId, input.branchId));
  return database
    .select({ encounterId: encounters.id, startedAt: encounters.startedAt, patientId: encounters.patientId, dob: patients.dob, sex: patients.sex, diagnosis: diagnoses.description, icd10: diagnoses.icd10Code })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(diagnoses, eq(diagnoses.encounterId, encounters.id))
    .where(and(...conditions));
}

function ageAt(date: Date | string | null, ref: Date): number {
  if (!date) return 999;
  const d = date instanceof Date ? date : new Date(date);
  let age = ref.getUTCFullYear() - d.getUTCFullYear();
  const m = ref.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function matches705A(rowCode: string, diagnosis: string | null) {
  const d = (diagnosis ?? "").toLowerCase();
  const map: Record<string, string[]> = {
    "1": ["diarrhoea no dehydration", "diarrhea no dehydration"],
    "2": ["diarrhoea some dehydration", "diarrhea some dehydration"],
    "3": ["diarrhoea severe dehydration", "diarrhea severe dehydration"],
    "4": ["cholera"],
    "5": ["dysentery", "bloody diarrhoea"],
    "6": ["gastroenteritis"],
    "7": ["pneumonia"],
    "8": ["severe pneumonia"],
    "9": ["upper respiratory", "urti"],
    "10": ["lower respiratory", "lrti"],
    "11": ["asthma"],
    "12": ["presumed tuberculosis", "tuberculosis"],
    "13": ["suspected malaria"],
    "14": ["tested for malaria"],
    "15": ["confirmed malaria"],
    "16": ["ear infection", "otitis"],
    "17": ["malnutrition"],
    "18": ["anaemia", "anemia"],
    "19": ["meningococcal meningitis"],
    "20": ["meningitis"],
  };
  const needles = map[rowCode];
  if (!needles) return rowCode === "25" ? !!d : false;
  return needles.some((n) => d.includes(n));
}

function matches705B(rowCode: string, diagnosis: string | null) {
  const d = (diagnosis ?? "").toLowerCase();
  const map: Record<string, string[]> = {
    "1": ["diarrhoea", "diarrhea"], "2": ["tuberculosis"], "3": ["dysentery", "bloody diarrhoea"], "4": ["cholera"],
    "5": ["meningococcal meningitis"], "6": ["meningitis"], "7": ["tetanus"], "8": ["poliomyelitis", "afp"], "9": ["chicken pox", "varicella"],
    "10": ["measles"], "11": ["hepatitis"], "12": ["mumps"], "13": ["suspected malaria"], "14": ["confirmed malaria"], "15": ["malaria in pregnancy"],
    "16": ["amoebiasis"], "17": ["typhoid"], "18": ["sexually transmitted", "sti"], "19": ["urinary tract", "uti"], "20": ["bilharzia", "schistosomiasis"],
    "21": ["intestinal worms", "helminth"], "22": ["malnutrition"], "23": ["anaemia", "anemia"], "24": ["eye infection", "eye condition"],
    "25": ["ear infection", "ear condition"], "26": ["upper respiratory", "urti"], "27": ["asthma"], "28": ["pneumonia"], "29": ["other lower respiratory"],
    "30": ["abortion"], "31": ["puerperium", "childbirth"], "32": ["hypertension"], "33": ["mental disorder"], "34": ["dental"],
    "35": ["jiggers"], "36": ["skin"], "37": ["arthritis", "joint pain"], "38": ["poisoning"], "39": ["road traffic"],
    "40": ["death due to road traffic"], "41": ["injury"], "42": ["sexual violence"], "43": ["violence related"], "44": ["burn"],
    "45": ["snake bite"], "46": ["dog bite"], "47": ["diabetes"], "48": ["epilepsy"], "49": ["convulsive"], "50": ["rheumatic fever"],
    "51": ["brucellosis"], "52": ["rickets"], "53": ["cerebral palsy"],
  };
  const needles = map[rowCode];
  if (!needles) return rowCode === "54" ? !!d : false;
  return needles.some((n) => d.includes(n));
}

export async function generateMoh705A(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh705ATemplate(input.year, input.month);
  const cells = emptyCellsFromTemplate(template);
  const rows = await fetchOutpatientDiagnoses(database, input);
  const dayCounts = new Map<string, Set<string>>(); // section|rowCode|colKey -> encounterIds
  for (const r of rows) {
    const started = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt as Date | string);
    if (ageAt(r.dob, started) >= 5) continue;
    const dk = dayKey(started.toISOString().slice(0, 10));
    const section = "A";
    let matched = false;
    for (const row of template.sections[0].rows) {
      if (row.rowCode === "99" || row.rowCode === "25") continue;
      if (matches705A(row.rowCode, r.diagnosis)) {
        matched = true;
        const key = `${section}|${row.rowCode}|${dk}`;
        if (!dayCounts.has(key)) dayCounts.set(key, new Set());
        dayCounts.get(key)!.add(r.encounterId);
      }
    }
    if (!matched && r.diagnosis) {
      const key = `${section}|25|${dk}`;
      if (!dayCounts.has(key)) dayCounts.set(key, new Set());
      dayCounts.get(key)!.add(r.encounterId);
    }
  }
  for (const [key, ids] of dayCounts) {
    const [, rowCode, colKey] = key.split("|");
    setCell(cells, "A", rowCode, colKey, ids.size, `SELECT encounter_id FROM encounters/diagnoses WHERE facility='${input.facilityId}' AND period=${input.periodStart}..${input.periodEnd} AND row='${rowCode}' AND day='${colKey}'`);
  }
  finalizeDailyTotals(cells, "A");
  // TOTAL row = sum of all disease rows per day
  const diseaseRows = template.sections[0].rows.filter((r) => r.rowCode !== "99").map((r) => r.rowCode);
  for (const col of template.sections[0].columns) {
    let total = 0;
    for (const rc of diseaseRows) total += Number(cells.find((c) => c.section === "A" && c.rowCode === rc && c.colKey === col.colKey)?.valueNumeric ?? 0);
    setCell(cells, "A", "99", col.colKey, total);
  }
  return cells;
}

export async function generateMoh705B(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh705BTemplate(input.year, input.month);
  const cells = emptyCellsFromTemplate(template);
  const rows = await fetchOutpatientDiagnoses(database, input);
  const dayCounts = new Map<string, Set<string>>();
  for (const r of rows) {
    const started = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt as Date | string);
    if (ageAt(r.dob, started) < 5) continue;
    const dk = dayKey(started.toISOString().slice(0, 10));
    let matched = false;
    for (const row of template.sections[0].rows) {
      if (row.rowCode === "99" || row.rowCode === "54") continue;
      if (matches705B(row.rowCode, r.diagnosis)) {
        matched = true;
        const key = `A|${row.rowCode}|${dk}`;
        if (!dayCounts.has(key)) dayCounts.set(key, new Set());
        dayCounts.get(key)!.add(r.encounterId);
      }
    }
    if (!matched && r.diagnosis) {
      const key = `A|54|${dk}`;
      if (!dayCounts.has(key)) dayCounts.set(key, new Set());
      dayCounts.get(key)!.add(r.encounterId);
    }
  }
  for (const [key, ids] of dayCounts) {
    const [, rowCode, colKey] = key.split("|");
    setCell(cells, "A", rowCode, colKey, ids.size, `SELECT encounter_id FROM encounters/diagnoses WHERE facility='${input.facilityId}' AND period=${input.periodStart}..${input.periodEnd} AND row='${rowCode}' AND day='${colKey}'`);
  }
  finalizeDailyTotals(cells, "A");
  const diseaseRows = template.sections[0].rows.filter((r) => r.rowCode !== "99").map((r) => r.rowCode);
  for (const col of template.sections[0].columns) {
    let total = 0;
    for (const rc of diseaseRows) total += Number(cells.find((c) => c.section === "A" && c.rowCode === rc && c.colKey === col.colKey)?.valueNumeric ?? 0);
    setCell(cells, "A", "99", col.colKey, total);
  }
  return cells;
}

export async function generateMoh717(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh717Template();
  const cells = emptyCellsFromTemplate(template);
  const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${input.periodEnd}T23:59:59.999Z`);
  const rows = await database
    .select({ id: encounters.id, startedAt: encounters.startedAt, patientId: encounters.patientId, dob: patients.dob, sex: patients.sex })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .where(and(eq(encounters.facilityId, input.facilityId), gte(encounters.startedAt, periodStart), lte(encounters.startedAt, periodEnd), ...(input.branchId ? [eq(encounters.branchId, input.branchId)] : [])));

  const patientIds = Array.from(new Set(rows.map((r) => r.patientId)));
  const priorByPatient = new Set<string>();
  if (patientIds.length > 0) {
    const prior = await database
      .select({ patientId: encounters.patientId })
      .from(encounters)
      .where(and(eq(encounters.facilityId, input.facilityId), inArray(encounters.patientId, patientIds), lt(encounters.startedAt, periodStart)));
    for (const p of prior) priorByPatient.add(p.patientId);
  }

  const buckets: Record<string, { new: number; re: number }> = {};
  const bump = (rc: string, revisit: boolean) => {
    buckets[rc] ??= { new: 0, re: 0 };
    if (revisit) buckets[rc].re++;
    else buckets[rc].new++;
  };
  for (const r of rows) {
    const started = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt as Date | string);
    const age = ageAt(r.dob, started);
    const male = (r.sex ?? "").toLowerCase() === "male";
    const revisit = priorByPatient.has(r.patientId);
    if (age < 5) bump(male ? "A.1.3" : "A.1.4", revisit);
    else bump(male ? "A.1.1" : "A.1.2", revisit);
    if (age >= 60) bump("A.1.60", revisit);
  }
  for (const [rc, v] of Object.entries(buckets)) {
    setCell(cells, rc.startsWith("A.1") ? "A1" : rc.startsWith("A.2") ? "A2" : "A3", rc, "new", v.new);
    setCell(cells, rc.startsWith("A.1") ? "A1" : rc.startsWith("A.2") ? "A2" : "A3", rc, "re_att", v.re);
    setCell(cells, rc.startsWith("A.1") ? "A1" : rc.startsWith("A.2") ? "A2" : "A3", rc, "total", v.new + v.re);
  }
  // A.1.5 total
  for (const col of ["new", "re_att", "total"] as const) {
    const total = ["A.1.1", "A.1.2", "A.1.3", "A.1.4"].reduce((n, rc) => n + Number(cells.find((c) => c.section === "A1" && c.rowCode === rc && c.colKey === col)?.valueNumeric ?? 0), 0);
    setCell(cells, "A1", "A.1.5T", col, total);
  }
  // ensure every row has total = new+re_att
  for (const section of template.sections) for (const row of section.rows) {
    const n = Number(cells.find((c) => c.section === section.key && c.rowCode === row.rowCode && c.colKey === "new")?.valueNumeric ?? 0);
    const r = Number(cells.find((c) => c.section === section.key && c.rowCode === row.rowCode && c.colKey === "re_att")?.valueNumeric ?? 0);
    setCell(cells, section.key, row.rowCode, "total", n + r);
  }
  // recompute A.1.5 after totals
  for (const col of ["new", "re_att", "total"] as const) {
    const total = ["A.1.1", "A.1.2", "A.1.3", "A.1.4"].reduce((n, rc) => n + Number(cells.find((c) => c.section === "A1" && c.rowCode === rc && c.colKey === col)?.valueNumeric ?? 0), 0);
    setCell(cells, "A1", "A.1.5T", col, total);
  }

  const births = await database.select({ id: birthNotifications.id }).from(birthNotifications).where(and(eq(birthNotifications.facilityId, input.facilityId), gte(birthNotifications.birthDate, input.periodStart), lte(birthNotifications.birthDate, input.periodEnd)));
  const deaths = await database.select({ id: deathNotifications.id }).from(deathNotifications).where(and(eq(deathNotifications.facilityId, input.facilityId), gte(deathNotifications.dateOfDeath, input.periodStart), lte(deathNotifications.dateOfDeath, input.periodEnd)));
  setCell(cells, "B", "B.1", "new", births.length, `SELECT id FROM birth_notifications WHERE facility='${input.facilityId}' AND birth_date BETWEEN '${input.periodStart}' AND '${input.periodEnd}'`);
  setCell(cells, "B", "B.1", "re_att", 0);
  setCell(cells, "B", "B.1", "total", births.length);
  setCell(cells, "B", "B.2", "new", deaths.length, `SELECT id FROM death_notifications WHERE facility='${input.facilityId}' AND date_of_death BETWEEN '${input.periodStart}' AND '${input.periodEnd}'`);
  setCell(cells, "B", "B.2", "re_att", 0);
  setCell(cells, "B", "B.2", "total", deaths.length);
  return cells;
}

export async function generateMoh505(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh505Template();
  const cells = emptyCellsFromTemplate(template);
  const epi = input.epiWeek && input.epiYear ? { weekStart: input.periodStart, weekEnding: input.periodEnd } : getEpiWeek(input.periodEnd);
  const events = await database.select({ diseaseName: notifiableEvents.diseaseName, diseaseCode: notifiableEvents.diseaseCode, detectedAt: notifiableEvents.detectedAt, patientId: notifiableEvents.patientId, status: notifiableEvents.status })
    .from(notifiableEvents)
    .where(and(eq(notifiableEvents.facilityId, input.facilityId), gte(notifiableEvents.detectedAt, new Date(`${epi.weekStart}T00:00:00.000Z`)), lte(notifiableEvents.detectedAt, new Date(`${epi.weekEnding}T23:59:59.999Z`))));
  const patientIds = Array.from(new Set(events.map((e) => e.patientId).filter(Boolean))) as string[];
  const patientRows = patientIds.length ? await database.select({ id: patients.id, dob: patients.dob }).from(patients).where(inArray(patients.id, patientIds)) : [];
  const dobById = new Map(patientRows.map((p) => [p.id, p.dob]));
  const diseaseMap: Record<string, string[]> = { AJ: ["acute jaundice"], AM: ["acute malnutrition"], AEFI: ["aefi", "adverse events following immunization"], AFP: ["afp", "poliomyelitis", "acute flaccid paralysis"], ANT: ["anthrax"], CHOL: ["cholera"], DENG: ["dengue"], DYS: ["dysentery", "bacillary"], GWD: ["guinea worm"], MAL: ["malaria"], MATD: ["maternal death"], MEA: ["measles"], NEOD: ["neonatal death"], NNT: ["neonatal tetanus"], PLG: ["plague"], RAB: ["rabies"], RVF: ["rift valley fever"], SARI: ["sari"], MDRTB: ["mdr", "xdr", "tuberculosis"], TYP: ["typhoid"], VHF: ["vhf", "viral haemorrhagic"], YF: ["yellow fever"] };
  for (const ev of events) {
    if (ev.status === "void") continue;
    const name = (ev.diseaseName ?? ev.diseaseCode ?? "").toLowerCase();
    const refDate = ev.detectedAt instanceof Date ? ev.detectedAt : new Date(String(ev.detectedAt ?? input.periodEnd));
    const age = ev.patientId ? ageAt(dobById.get(ev.patientId) ?? null, refDate) : 99;
    const isUnder5 = age < 5;
    let rowCode = "OTH";
    for (const [rc, needles] of Object.entries(diseaseMap)) { if (needles.some((n) => name.includes(n))) { rowCode = rc; break; } }
    const section = template.sections.find((s) => s.rows.some((r) => r.rowCode === rowCode))?.key ?? "RIGHT";
    const caseCol = isUnder5 ? "lt5_cases" : "ge5_cases";
    const cur = Number(cells.find((c) => c.section === section && c.rowCode === rowCode && c.colKey === caseCol)?.valueNumeric ?? 0);
    setCell(cells, section, rowCode, caseCol, cur + 1, `SELECT id FROM notifiable_events WHERE facility='${input.facilityId}' AND week=${epi.weekStart}`);
  }
  for (const section of ["LEFT", "RIGHT"] as const) {
    for (const row of template.sections.find((s) => s.key === section)!.rows) {
      const lt5c = Number(cells.find((c) => c.section === section && c.rowCode === row.rowCode && c.colKey === "lt5_cases")?.valueNumeric ?? 0);
      const ge5c = Number(cells.find((c) => c.section === section && c.rowCode === row.rowCode && c.colKey === "ge5_cases")?.valueNumeric ?? 0);
      const lt5d = Number(cells.find((c) => c.section === section && c.rowCode === row.rowCode && c.colKey === "lt5_deaths")?.valueNumeric ?? 0);
      const ge5d = Number(cells.find((c) => c.section === section && c.rowCode === row.rowCode && c.colKey === "ge5_deaths")?.valueNumeric ?? 0);
      setCell(cells, section, row.rowCode, "total_cases", lt5c + ge5c);
      setCell(cells, section, row.rowCode, "total_deaths", lt5d + ge5d);
    }
  }
  for (const row of template.sections.find((s) => s.key === "LAB")!.rows) {
    for (const prefix of ["tested", "pos"] as const) {
      const lt5 = Number(cells.find((c) => c.section === "LAB" && c.rowCode === row.rowCode && c.colKey === `lt5_${prefix}`)?.valueNumeric ?? 0);
      const ge5 = Number(cells.find((c) => c.section === "LAB" && c.rowCode === row.rowCode && c.colKey === `ge5_${prefix}`)?.valueNumeric ?? 0);
      setCell(cells, "LAB", row.rowCode, `total_${prefix}`, lt5 + ge5);
    }
  }
  return cells;
}

function sourceNote(reportCode: string, input: GenerateMohInput) {
  return `${reportCode} source rows: facility=${input.facilityId} branch=${input.branchId ?? "all"} period=${input.periodStart}..${input.periodEnd}`;
}

function appendCell(cells: MohCell[], cell: MohCell) {
  cells.push({ ...cell, sortOrder: cells.length });
}

export async function generateMoh710A(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh710ATemplate(input.year, input.month);
  const cells = emptyCellsFromTemplate(template);
  const sources = await fetchMohSources(database, input);
  const counts = new Map<string, Set<string>>();
  for (const event of sources.doses) {
    if (!event.doseCode) continue;
    const day = dayKeyOf(event.administeredAt);
    if (!day) continue;
    const key = `${event.doseCode}|${day}`;
    if (!counts.has(key)) counts.set(key, new Set());
    counts.get(key)!.add(event.id);
  }
  for (const [key, ids] of counts) {
    const [rowCode, colKey] = key.split("|");
    setCell(cells, "A", rowCode, colKey, ids.size, sourceNote(`MOH710A immunizations ${rowCode}/${colKey}`, input));
  }
  finalizeDailyTotals(cells, "A");
  for (const cell of cells) {
    if (!cell.sourceQuery) cell.sourceQuery = sourceNote(`MOH710A immunizations ${cell.rowCode}/${cell.colKey}`, input);
  }
  return cells;
}

export async function generateMoh710B(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const cells = emptyCellsFromTemplate(moh710BTemplate());
  const sources = await fetchMohSources(database, input);
  const sumQty = (rows: Array<{ qtyDelta: number }>) => rows.reduce((total, row) => total + row.qtyDelta, 0);

  for (const antigen of MOH710B_ANTIGENS) {
    const stockFor = (suffix: string) =>
      sources.stock.filter((event) => stockMatchesMoh710BCell(event, antigen, suffix, input));
    const doseRows = sources.doses.filter((event) => doseMatchesMoh710BCell(event, antigen));
    const opening = sumQty(stockFor("A"));
    const received = sumQty(stockFor("B"));
    const used = doseRows.length;
    const vaccinated = new Set(doseRows.map((event) => event.patientId)).size;
    const wasted = Math.abs(sumQty(stockFor("G")));
    const values: Record<string, number> = {
      A: opening,
      B: received,
      C: opening + received,
      D: opening + received - used - wasted,
      E: used,
      F: vaccinated,
      G: wasted,
      H: used === 0 ? 0 : Number(((wasted / used) * 100).toFixed(2)),
    };
    for (const [suffix, value] of Object.entries(values)) {
      setCell(cells, "A", `${antigen}:${suffix}`, "value", value, sourceNote(`MOH710B ${antigen}/${suffix} stock_ledger+immunizations`, input));
    }
  }
  return cells;
}

export async function generateMoh416(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh416Template();
  const cells = emptyCellsFromTemplate(template);
  const sources = await fetchMohSources(database, input);
  const eyes = sources.eyes;
  const totalSeen = eyes.length;

  const register = template.sections.find((section) => section.key === "REGISTER")!;
  eyes.forEach((event, index) => {
    const values: Record<string, string | number> = {
      no: index + 1,
      visit_id: event.encounterId,
      branch: event.branchName,
      patient_no: event.mrn,
      patient_name: event.patientName,
      age: event.age === 999 ? "" : event.age,
      gender: event.sex,
      county: event.county ?? "",
      residence: event.residence ?? "",
      phone: event.phone ?? "",
      va_re: event.vaRight ?? "",
      va_le: event.vaLeft ?? "",
      disability: event.disabilityType ?? "",
      impression: event.impression ?? "",
      diagnosis: event.diagnosisCode,
      management: event.management ?? "",
      date: isoOrNull(event.visitedAt)?.slice(0, 10) ?? "",
      time_reg: isoOrNull(event.timeRegistered)?.slice(11, 16) ?? "",
      time_seen: isoOrNull(event.timeSeen)?.slice(11, 16) ?? "",
      registered_by: event.registeredBy ?? "",
      seen_by: event.seenBy,
      pay_type: event.payerType,
      last_stage: event.lastStage,
      referral: event.referral ?? "",
    };
    for (const column of register.columns) {
      const value = values[column.colKey] ?? "";
      appendCell(cells, {
        section: "REGISTER",
        rowCode: event.id,
        rowLabel: event.patientName,
        colKey: column.colKey,
        colLabel: column.colLabel,
        valueNumeric: typeof value === "number" ? value : null,
        valueText: typeof value === "string" ? value : null,
        sortOrder: 0,
        sourceQuery: sourceNote(`MOH416 register ${event.id}/${column.colKey}`, input),
      });
    }
  });

  setCell(cells, "SUMMARY", "total_seen", "value", totalSeen, sourceNote("MOH416 total_seen eye_assessments", input));
  setCell(cells, "SUMMARY", "total_not_seen", "value", 0, sourceNote("MOH416 total_not_seen (no unseened register rows)", input));
  setCell(cells, "SUMMARY", "direct_service", "value", 0, sourceNote("MOH416 direct_service (no dedicated source rows)", input));
  setCell(cells, "SUMMARY", "net_seen", "value", totalSeen, sourceNote("MOH416 net_seen eye_assessments", input));

  for (const row of template.sections.find((section) => section.key === "DEPTS")!.rows) {
    const count = row.rowCode === "total" ? totalSeen : eyes.filter((event) => event.visitType === row.rowCode).length;
    setCell(cells, "DEPTS", row.rowCode, "value", count, sourceNote(`MOH416 DEPTS ${row.rowCode}`, input));
  }
  for (const row of template.sections.find((section) => section.key === "QUEUE")!.rows) {
    const count = sources.queues.filter((event) => event.status === row.rowCode).length;
    setCell(cells, "QUEUE", row.rowCode, "value", count, sourceNote(`MOH416 QUEUE ${row.rowCode}`, input));
  }
  for (const row of template.sections.find((section) => section.key === "AGE")!.rows) {
    const count = eyes.filter((event) => eyeMatchesMoh416Cell(event, "AGE", row.rowCode)).length;
    setCell(cells, "AGE", row.rowCode, "value", count, sourceNote(`MOH416 AGE ${row.rowCode}`, input));
  }
  for (const row of template.sections.find((section) => section.key === "VISUAL_ACUITY")!.rows) {
    const count = eyes.filter((event) => eyeMatchesMoh416Cell(event, "VISUAL_ACUITY", row.rowCode)).length;
    setCell(cells, "VISUAL_ACUITY", row.rowCode, "value", count, sourceNote(`MOH416 visual acuity ${row.rowCode}`, input));
  }

  const addBreakdown = (section: string, entries: Array<{ rowCode: string; rowLabel: string; value: number }>) => {
    entries.forEach((entry) => {
      appendCell(cells, {
        section,
        rowCode: entry.rowCode,
        rowLabel: entry.rowLabel,
        colKey: "value",
        colLabel: "Value",
        valueNumeric: entry.value,
        valueText: null,
        sortOrder: 0,
        sourceQuery: sourceNote(`MOH416 ${section} ${entry.rowCode}`, input),
      });
    });
  };
  const grouped = (key: (event: (typeof eyes)[number]) => string) => {
    const map = new Map<string, number>();
    for (const event of eyes) {
      const label = key(event) || "Unspecified";
      map.set(label, (map.get(label) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  };
  addBreakdown("DOCTORS", grouped((event) => event.seenBy).map(([label, value]) => ({ rowCode: label, rowLabel: label, value })));
  const diagnosisLabels = new Map(moh735Template().sections.find((section) => section.key === "D")!.rows.map((row) => [row.rowCode, row.rowLabel]));
  addBreakdown("DIAGNOSIS", grouped((event) => event.normalizedDiagnosis).map(([label, value]) => ({ rowCode: label, rowLabel: diagnosisLabels.get(label) ?? label, value })));
  const branches = grouped((event) => event.branchName);
  addBreakdown("BRANCHES", branches.map(([label, value]) => ({ rowCode: label, rowLabel: label, value })));
  let allocated = 0;
  const residency = branches.map(([label, value], index) => {
    const percent = totalSeen === 0
      ? 0
      : index === branches.length - 1
        ? Number((100 - allocated).toFixed(2))
        : Number(((value / totalSeen) * 100).toFixed(2));
    allocated += percent;
    return { rowCode: label, rowLabel: label, percent };
  });
  addBreakdown("RESIDENCY", residency.map((row) => ({ ...row, value: row.percent })));
  for (const row of residency) {
    appendCell(cells, {
      section: "RESIDENCY",
      rowCode: row.rowCode,
      rowLabel: row.rowLabel,
      colKey: "percent",
      colLabel: "Percentage",
      valueNumeric: row.percent,
      valueText: null,
      sortOrder: 0,
      sourceQuery: sourceNote(`MOH416 RESIDENCY ${row.rowCode} percentage`, input),
    });
  }
  return cells;
}

export async function generateMoh735(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh735Template();
  const cells = emptyCellsFromTemplate(template);
  const sources = await fetchMohSources(database, input);
  const { start, end } = periodBounds(input);

  for (const section of template.sections) {
    if (section.key === "C") {
      const values: Record<string, number> = {
        beds: sources.eyeWardBeds,
        admissions: sources.eyes.filter((event) => event.admittedAt != null && event.admittedAt >= start && event.admittedAt <= end).length,
        discharges: sources.eyes.filter((event) => event.dischargedAt != null && event.dischargedAt >= start && event.dischargedAt <= end).length,
      };
      for (const [colKey, value] of Object.entries(values)) {
        setCell(cells, "C", "ward", colKey, value, sourceNote(`MOH735 C/${colKey} eye_assessments+facility_settings`, input));
      }
      continue;
    }
    for (const row of section.rows) {
      for (const column of section.columns) {
        const count = sources.eyes.filter((event) => eyeMatchesMoh735Cell(event, section.key, row.rowCode, column.colKey)).length;
        setCell(cells, section.key, row.rowCode, column.colKey, count, sourceNote(`MOH735 ${section.key}/${row.rowCode}/${column.colKey}`, input));
      }
    }
  }
  const diagSection = template.sections.find((section) => section.key === "D")!;
  for (const row of diagSection.rows) {
    const total = diagSection.columns
      .filter((column) => column.colKey !== "total")
      .reduce((sum, column) => sum + Number(cells.find((cell) => cell.section === "D" && cell.rowCode === row.rowCode && cell.colKey === column.colKey)?.valueNumeric ?? 0), 0);
    setCell(cells, "D", row.rowCode, "total", total, sourceNote(`MOH735 D/${row.rowCode} total`, input));
  }
  return cells;
}

export async function generateMohReport(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  switch (input.reportCode) {
    case "MOH705A": return generateMoh705A(database, input);
    case "MOH705B": return generateMoh705B(database, input);
    case "MOH717": return generateMoh717(database, input);
    case "MOH505": return generateMoh505(database, input);
    case "MOH710A": return generateMoh710A(database, input);
    case "MOH710B": return generateMoh710B(database, input);
    case "MOH416": return generateMoh416(database, input);
    case "MOH735": return generateMoh735(database, input);
  }
}

export function mohChecksum(cells: MohCell[]): string {
  return computeReportChecksum(cells.map((c) => ({ section: c.section, rowCode: c.rowCode, colKey: c.colKey, valueNumeric: c.valueNumeric == null ? null : String(c.valueNumeric), valueText: c.valueText, sortOrder: c.sortOrder, isTotal: c.isTotal })));
}
