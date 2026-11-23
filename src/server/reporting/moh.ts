import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";

import { computeReportChecksum, getEpiWeek } from "@/lib/reporting";
import { emptyCellsFromTemplate, finalizeDailyTotals, moh505Template, moh710ATemplate, moh710BTemplate, moh416Template, moh735Template, moh717Template, moh705ATemplate, moh705BTemplate, setCell, type MohCell, type MohReportCode } from "@/lib/moh-reporting";
import type { db } from "@/server/db/client";
import { birthNotifications, deathNotifications, diagnoses, encounters, notifiableEvents, patients } from "@/server/db/schema";

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

export async function generateMoh710A(_db: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  void _db;
  const cells = emptyCellsFromTemplate(moh710ATemplate(input.year, input.month));
  finalizeDailyTotals(cells, "A");
  return cells;
}
export async function generateMoh710B(_db: ReportingDb, _input: GenerateMohInput): Promise<MohCell[]> {
  void _db;
  void _input;
  const template = moh710BTemplate();
  const cells = emptyCellsFromTemplate(template);
  // C=A+B, D=C-E-G, H=G/E
  const antigens = Array.from(new Set(cells.map((c) => c.rowCode?.split(":")[0]).filter(Boolean))) as string[];
  for (const ag of antigens) {
    const get = (s: string) => Number(cells.find((c) => c.rowCode === `${ag}:${s}`)?.valueNumeric ?? 0);
    setCell(cells, "A", `${ag}:C`, "value", get("A") + get("B"));
    setCell(cells, "A", `${ag}:D`, "value", get("A") + get("B") - get("E") - get("G"));
    const e = get("E");
    setCell(cells, "A", `${ag}:H`, "value", e === 0 ? 0 : Number(((get("G") / e) * 100).toFixed(2)));
  }
  return cells;
}
export async function generateMoh416(database: ReportingDb, input: GenerateMohInput): Promise<MohCell[]> {
  const template = moh416Template();
  const cells = emptyCellsFromTemplate(template);
  const encountersRows = await database.select({ id: encounters.id }).from(encounters).where(and(eq(encounters.facilityId, input.facilityId), gte(encounters.startedAt, new Date(`${input.periodStart}T00:00:00.000Z`)), lte(encounters.startedAt, new Date(`${input.periodEnd}T23:59:59.999Z`)), ...(input.branchId ? [eq(encounters.branchId, input.branchId)] : [])));
  const totalSeen = encountersRows.length;
  setCell(cells, "SUMMARY", "total_seen", "value", totalSeen);
  setCell(cells, "SUMMARY", "total_not_seen", "value", 0);
  setCell(cells, "SUMMARY", "direct_service", "value", 0);
  setCell(cells, "SUMMARY", "net_seen", "value", totalSeen);
  return cells;
}
export async function generateMoh735(_db: ReportingDb, _input: GenerateMohInput): Promise<MohCell[]> {
  void _db;
  void _input;
  const template = moh735Template();
  const cells = emptyCellsFromTemplate(template);
  // diagnosis total = Normal + Low Vision + Blind across age bands/sex (all diag cols except total)
  for (const row of template.sections.find((s) => s.key === "D")!.rows) {
    const diagCols = template.sections.find((s) => s.key === "D")!.columns.filter((c) => c.colKey !== "total");
    const total = diagCols.reduce((n, c) => n + Number(cells.find((x) => x.section === "D" && x.rowCode === row.rowCode && x.colKey === c.colKey)?.valueNumeric ?? 0), 0);
    setCell(cells, "D", row.rowCode, "total", total);
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
