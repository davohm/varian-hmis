import { hashPassword } from "better-auth/crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { fromCents, toCents } from "../src/lib/billing";
import { ETIMS_SANDBOX_STUB_URL } from "../src/lib/tax";
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  DEFAULT_COST_CENTER,
  normalBalanceFor,
} from "../src/lib/finance";
import { newId } from "../src/lib/uuid";
import { recordAudit } from "../src/server/audit";
import { APP_MODE, DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import { hashSyncToken } from "../src/server/sync/auth";
import { seedRegulatoryDefaults } from "../src/server/regulatory-seed";
import {
  account,
  branches,
  facilities,
  facilityRegulatoryProfiles,
  facilitySettings,
  costCenters,
  icd10Codes,
  integrationSettings,
  itemBatches,
  items,
  labTests,
  ledgerAccounts,
  priceLists,
  prices,
  services,
  staffProfiles,
  staffRoleScopes,
  facilitySyncTokens,
  stockLedger,
  stores,
  taxCodes,
  user,
  type LabParameter,
  type Role,
} from "../src/server/db/schema";

// Branch nodes seed their own facility identity; HQ keeps the historical FAM
// defaults so existing deployments and tests are unchanged.
const FACILITY_CODE = process.env.SEED_FACILITY_CODE?.trim().toUpperCase() || "FAM";
const FACILITY_NAME = process.env.SEED_FACILITY_NAME?.trim() || "Family Afya Modern Medical Centre";
const BRANCH_CODE = process.env.SEED_BRANCH_CODE?.trim().toUpperCase() || "MAIN";
const BRANCH_NAME = process.env.SEED_BRANCH_NAME?.trim() || "Main Branch";
const FACILITY_COUNTY = process.env.SEED_COUNTY?.trim() || "Nairobi";
const STAFF_PASSWORD = "VarianHMIS2026!";

const STAFF_SEEDS: Array<{ role: Role; name: string; email: string; staffNumber: string }> = [
  { role: "receptionist", name: "Reception Officer", email: "receptionist@fam.test", staffNumber: "FAM-R001" },
  { role: "triage_nurse", name: "Triage Nurse", email: "triage@fam.test", staffNumber: "FAM-T001" },
  { role: "doctor", name: "Consulting Doctor", email: "doctor@fam.test", staffNumber: "FAM-D001" },
  { role: "lab_tech", name: "Laboratory Technician", email: "lab@fam.test", staffNumber: "FAM-L001" },
  { role: "pharmacist", name: "Pharmacist", email: "pharmacist@fam.test", staffNumber: "FAM-P001" },
  { role: "cashier", name: "Cashier", email: "cashier@fam.test", staffNumber: "FAM-C001" },
  { role: "accountant", name: "Accountant", email: "accountant@fam.test", staffNumber: "FAM-F001" },
  { role: "finance_officer", name: "Finance Officer", email: "finance@fam.test", staffNumber: "FAM-F002" },
  { role: "revenue_cycle_officer", name: "Revenue Cycle Officer", email: "revenue@fam.test", staffNumber: "FAM-F003" },
  { role: "auditor", name: "Auditor", email: "auditor@fam.test", staffNumber: "FAM-F004" },
  { role: "admin", name: "System Administrator", email: "admin@fam.test", staffNumber: "FAM-A001" },
];

interface LabTestSeed {
  code: string;
  name: string;
  sampleType: string;
  parameters: LabParameter[];
}

const LAB_TEST_SEEDS: LabTestSeed[] = [
  {
    code: "FBC",
    name: "Full Blood Count",
    sampleType: "Whole blood (EDTA)",
    parameters: [
      { name: "Haemoglobin", unit: "g/dL", refLow: 12, refHigh: 17, criticalLow: 7, criticalHigh: 20 },
      { name: "White cell count", unit: "10^9/L", refLow: 4, refHigh: 11, criticalLow: 1.5, criticalHigh: 30 },
      { name: "Platelets", unit: "10^9/L", refLow: 150, refHigh: 450, criticalLow: 50, criticalHigh: 1000 },
      { name: "MCV", unit: "fL", refLow: 80, refHigh: 100, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "MP",
    name: "Malaria Parasites",
    sampleType: "Whole blood (EDTA)",
    parameters: [
      { name: "Parasite density", unit: "parasites/uL", refLow: null, refHigh: 0, criticalLow: null, criticalHigh: 100000 },
    ],
  },
  {
    code: "RBS",
    name: "Random Blood Sugar",
    sampleType: "Capillary blood",
    parameters: [
      { name: "Glucose", unit: "mmol/L", refLow: 3.9, refHigh: 7.8, criticalLow: 2.5, criticalHigh: 20 },
    ],
  },
  {
    code: "HBA1C",
    name: "Glycated Haemoglobin",
    sampleType: "Whole blood (EDTA)",
    parameters: [
      { name: "HbA1c", unit: "%", refLow: 4, refHigh: 5.7, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "UEC",
    name: "Urea, Electrolytes and Creatinine",
    sampleType: "Serum",
    parameters: [
      { name: "Sodium", unit: "mmol/L", refLow: 135, refHigh: 145, criticalLow: 120, criticalHigh: 160 },
      { name: "Potassium", unit: "mmol/L", refLow: 3.5, refHigh: 5.1, criticalLow: 2.5, criticalHigh: 6.5 },
      { name: "Urea", unit: "mmol/L", refLow: 2.5, refHigh: 7.1, criticalLow: null, criticalHigh: 30 },
      { name: "Creatinine", unit: "umol/L", refLow: 53, refHigh: 115, criticalLow: null, criticalHigh: 500 },
    ],
  },
  {
    code: "LFT",
    name: "Liver Function Tests",
    sampleType: "Serum",
    parameters: [
      { name: "ALT", unit: "U/L", refLow: 7, refHigh: 56, criticalLow: null, criticalHigh: 500 },
      { name: "AST", unit: "U/L", refLow: 10, refHigh: 40, criticalLow: null, criticalHigh: 500 },
      { name: "Total bilirubin", unit: "umol/L", refLow: 3, refHigh: 21, criticalLow: null, criticalHigh: 200 },
      { name: "Alkaline phosphatase", unit: "U/L", refLow: 40, refHigh: 129, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "URIN",
    name: "Urinalysis",
    sampleType: "Midstream urine",
    parameters: [
      { name: "Protein", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
      { name: "Glucose", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
      { name: "Nitrites", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
      { name: "Leucocytes", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "PREG",
    name: "Pregnancy Test",
    sampleType: "Urine",
    parameters: [
      { name: "Beta hCG", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "TSH",
    name: "Thyroid Stimulating Hormone",
    sampleType: "Serum",
    parameters: [
      { name: "TSH", unit: "mIU/L", refLow: 0.4, refHigh: 4, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "HIV",
    name: "HIV Antibody Screen",
    sampleType: "Serum",
    parameters: [
      { name: "HIV antibody", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "HBSAG",
    name: "Hepatitis B Surface Antigen",
    sampleType: "Serum",
    parameters: [
      { name: "HBsAg", unit: "", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
    ],
  },
  {
    code: "WIDAL",
    name: "Widal Test",
    sampleType: "Serum",
    parameters: [
      { name: "S. typhi O", unit: "titre", refLow: null, refHigh: 80, criticalLow: null, criticalHigh: null },
      { name: "S. typhi H", unit: "titre", refLow: null, refHigh: 160, criticalLow: null, criticalHigh: null },
    ],
  },
];

interface ItemSeed {
  code: string;
  name: string;
  unit: string;
  strength: string | null;
  form: string | null;
}

const DRUG_SEEDS: ItemSeed[] = [
  { code: "PARA500", name: "Paracetamol", unit: "tablet", strength: "500 mg", form: "Tablet" },
  { code: "PARA120", name: "Paracetamol Syrup", unit: "bottle", strength: "120 mg/5 mL", form: "Suspension" },
  { code: "IBU400", name: "Ibuprofen", unit: "tablet", strength: "400 mg", form: "Tablet" },
  { code: "DICLO50", name: "Diclofenac", unit: "tablet", strength: "50 mg", form: "Tablet" },
  { code: "AMOX500", name: "Amoxicillin", unit: "capsule", strength: "500 mg", form: "Capsule" },
  { code: "AMOXCLAV625", name: "Amoxicillin-Clavulanate", unit: "tablet", strength: "625 mg", form: "Tablet" },
  { code: "AZITH500", name: "Azithromycin", unit: "tablet", strength: "500 mg", form: "Tablet" },
  { code: "CIPRO500", name: "Ciprofloxacin", unit: "tablet", strength: "500 mg", form: "Tablet" },
  { code: "METRO400", name: "Metronidazole", unit: "tablet", strength: "400 mg", form: "Tablet" },
  { code: "COTRIM960", name: "Co-trimoxazole", unit: "tablet", strength: "960 mg", form: "Tablet" },
  { code: "DOXY100", name: "Doxycycline", unit: "capsule", strength: "100 mg", form: "Capsule" },
  { code: "CETIR10", name: "Cetirizine", unit: "tablet", strength: "10 mg", form: "Tablet" },
  { code: "LORA10", name: "Loratadine", unit: "tablet", strength: "10 mg", form: "Tablet" },
  { code: "OMEP20", name: "Omeprazole", unit: "capsule", strength: "20 mg", form: "Capsule" },
  { code: "RANT150", name: "Ranitidine", unit: "tablet", strength: "150 mg", form: "Tablet" },
  { code: "METFORMIN500", name: "Metformin", unit: "tablet", strength: "500 mg", form: "Tablet" },
  { code: "GLIB5", name: "Glibenclamide", unit: "tablet", strength: "5 mg", form: "Tablet" },
  { code: "AMLOD5", name: "Amlodipine", unit: "tablet", strength: "5 mg", form: "Tablet" },
  { code: "LISIN10", name: "Lisinopril", unit: "tablet", strength: "10 mg", form: "Tablet" },
  { code: "HCTZ25", name: "Hydrochlorothiazide", unit: "tablet", strength: "25 mg", form: "Tablet" },
  { code: "ATEN50", name: "Atenolol", unit: "tablet", strength: "50 mg", form: "Tablet" },
  { code: "SALB100", name: "Salbutamol Inhaler", unit: "inhaler", strength: "100 mcg/dose", form: "Inhaler" },
  { code: "PRED5", name: "Prednisolone", unit: "tablet", strength: "5 mg", form: "Tablet" },
  { code: "ARTEM20", name: "Artemether-Lumefantrine", unit: "tablet", strength: "20/120 mg", form: "Tablet" },
  { code: "QUIN300", name: "Quinine", unit: "tablet", strength: "300 mg", form: "Tablet" },
  { code: "ORS", name: "Oral Rehydration Salts", unit: "sachet", strength: null, form: "Powder" },
  { code: "ZINC20", name: "Zinc Sulphate", unit: "tablet", strength: "20 mg", form: "Tablet" },
  { code: "FERR200", name: "Ferrous Sulphate", unit: "tablet", strength: "200 mg", form: "Tablet" },
  { code: "FOLIC5", name: "Folic Acid", unit: "tablet", strength: "5 mg", form: "Tablet" },
  { code: "VITC100", name: "Ascorbic Acid", unit: "tablet", strength: "100 mg", form: "Tablet" },
  { code: "HYDRO25", name: "Hydrocortisone Cream", unit: "tube", strength: "1%", form: "Cream" },
  { code: "CLOTRI1", name: "Clotrimazole Cream", unit: "tube", strength: "1%", form: "Cream" },
  { code: "GENTA01", name: "Gentamicin Eye Drops", unit: "bottle", strength: "0.3%", form: "Drops" },
  { code: "NSALINE", name: "Normal Saline", unit: "bag", strength: "0.9% 500 mL", form: "Infusion" },
  { code: "RINGER", name: "Ringer's Lactate", unit: "bag", strength: "500 mL", form: "Infusion" },
  { code: "TRAMA50", name: "Tramadol", unit: "capsule", strength: "50 mg", form: "Capsule" },
  { code: "DIAZ5", name: "Diazepam", unit: "tablet", strength: "5 mg", form: "Tablet" },
  { code: "AMIT25", name: "Amitriptyline", unit: "tablet", strength: "25 mg", form: "Tablet" },
  { code: "FLUOX20", name: "Fluoxetine", unit: "capsule", strength: "20 mg", form: "Capsule" },
  { code: "CARBAM200", name: "Carbamazepine", unit: "tablet", strength: "200 mg", form: "Tablet" },
];

/** Minimal RFC 4180 parser: handles quoted fields, embedded commas and CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim().length > 0));
}

async function upsertIcd10(db: ReturnType<typeof createDatabase>["db"]) {
  const file = await readFile(join(process.cwd(), "data", "icd10.csv"), "utf8");
  const [, ...rows] = parseCsv(file);

  const codes = rows.map(([code, description, chapter]) => ({
    code: code.trim(),
    description: description.trim(),
    chapter: chapter.trim() || null,
  }));

  const existing = codes.length
    ? await db
        .select({ code: icd10Codes.code })
        .from(icd10Codes)
        .where(inArray(icd10Codes.code, codes.map((entry) => entry.code)))
    : [];
  const known = new Set(existing.map((entry) => entry.code));
  const missing = codes.filter((entry) => !known.has(entry.code));

  if (missing.length > 0) {
    await db.insert(icd10Codes).values(
      missing.map((entry) => ({
        id: newId(),
        code: entry.code,
        description: entry.description,
        chapter: entry.chapter,
      })),
    );
  }

  return { total: codes.length, inserted: missing.length };
}

async function upsertLabTests(db: ReturnType<typeof createDatabase>["db"]) {
  const existing = await db
    .select({ code: labTests.code })
    .from(labTests)
    .where(inArray(labTests.code, LAB_TEST_SEEDS.map((test) => test.code)));
  const known = new Set(existing.map((entry) => entry.code));
  const missing = LAB_TEST_SEEDS.filter((test) => !known.has(test.code));

  if (missing.length > 0) {
    await db.insert(labTests).values(
      missing.map((test) => ({
        id: newId(),
        facilityId: null,
        code: test.code,
        name: test.name,
        sampleType: test.sampleType,
        parameters: test.parameters,
        createdBy: "seed",
      })),
    );
  }

  return { total: LAB_TEST_SEEDS.length, inserted: missing.length };
}

async function upsertDrugs(db: ReturnType<typeof createDatabase>["db"]) {
  const existing = await db
    .select({ code: items.code })
    .from(items)
    .where(inArray(items.code, DRUG_SEEDS.map((drug) => drug.code)));
  const known = new Set(existing.map((entry) => entry.code));
  const missing = DRUG_SEEDS.filter((drug) => !known.has(drug.code));

  if (missing.length > 0) {
    await db.insert(items).values(
      missing.map((drug) => ({
        id: newId(),
        facilityId: null,
        code: drug.code,
        name: drug.name,
        kind: "drug" as const,
        unit: drug.unit,
        strength: drug.strength,
        form: drug.form,
        createdBy: "seed",
      })),
    );
  }

  return { total: DRUG_SEEDS.length, inserted: missing.length };
}

/* ------------------------------------------------------------------ */
/* Billing catalogue                                                   */
/* ------------------------------------------------------------------ */

type SeedPayerType = "cash" | "sha" | "insurance";

const PAYER_TYPES: SeedPayerType[] = ["cash", "sha", "insurance"];

/** Negotiated lists sit above the cash counter price by payer. */
const PAYER_MARKUP: Record<SeedPayerType, number> = {
  cash: 1,
  sha: 1.1,
  insurance: 1.25,
};

interface ServiceSeed {
  code: string;
  name: string;
  kind: "consultation" | "lab" | "procedure";
  defaultPrice: string;
}

const SERVICE_SEEDS: ServiceSeed[] = [
  { code: "CONS", name: "General Consultation", kind: "consultation", defaultPrice: "1000.00" },
  { code: "DRESS", name: "Wound Dressing", kind: "procedure", defaultPrice: "500.00" },
];

/** Cash price per laboratory test, keyed by the test code. */
const LAB_PRICES: Record<string, string> = {
  FBC: "800.00",
  MP: "300.00",
  RBS: "200.00",
  HBA1C: "1200.00",
  UEC: "1500.00",
  LFT: "1800.00",
  URIN: "400.00",
  PREG: "300.00",
  TSH: "1500.00",
  HIV: "500.00",
  HBSAG: "700.00",
  WIDAL: "600.00",
};

/** Cash price per dispensing unit, keyed by the item code. */
const DRUG_PRICES: Record<string, string> = {
  PARA500: "2.00",
  PARA120: "150.00",
  IBU400: "3.00",
  DICLO50: "3.00",
  AMOX500: "5.00",
  AMOXCLAV625: "25.00",
  AZITH500: "30.00",
  CIPRO500: "8.00",
  METRO400: "3.00",
  COTRIM960: "3.00",
  DOXY100: "4.00",
  CETIR10: "2.00",
  LORA10: "2.00",
  OMEP20: "5.00",
  RANT150: "3.00",
  METFORMIN500: "3.00",
  GLIB5: "3.00",
  AMLOD5: "4.00",
  LISIN10: "4.00",
  HCTZ25: "3.00",
  ATEN50: "3.00",
  SALB100: "450.00",
  PRED5: "3.00",
  ARTEM20: "10.00",
  QUIN300: "8.00",
  ORS: "50.00",
  ZINC20: "3.00",
  FERR200: "3.00",
  FOLIC5: "2.00",
  VITC100: "2.00",
  HYDRO25: "120.00",
  CLOTRI1: "120.00",
  GENTA01: "150.00",
  NSALINE: "120.00",
  RINGER: "140.00",
  TRAMA50: "6.00",
  DIAZ5: "3.00",
  AMIT25: "3.00",
  FLUOX20: "6.00",
  CARBAM200: "5.00",
};

function payerPrice(base: string, payer: SeedPayerType): string {
  return fromCents(Math.round(toCents(base) * PAYER_MARKUP[payer]));
}

/**
 * Services, one price list per payer and a price for every service and
 * medicine. Shared service rows are reused, existing prices are never
 * overwritten (a negotiated price outlives a re-seed).
 */
async function upsertBillingCatalog(
  db: ReturnType<typeof createDatabase>["db"],
  facilityId: string,
) {
  const serviceSeeds: ServiceSeed[] = [
    ...SERVICE_SEEDS,
    ...LAB_TEST_SEEDS.map((test) => ({
      code: test.code,
      name: test.name,
      kind: "lab" as const,
      defaultPrice: LAB_PRICES[test.code] ?? "500.00",
    })),
  ];
  const serviceCodes = serviceSeeds.map((service) => service.code);

  const existingServices = await db
    .select({ code: services.code })
    .from(services)
    .where(and(isNull(services.facilityId), inArray(services.code, serviceCodes)));
  const knownServices = new Set(existingServices.map((row) => row.code));
  const missingServices = serviceSeeds.filter((service) => !knownServices.has(service.code));

  if (missingServices.length > 0) {
    await db.insert(services).values(
      missingServices.map((service) => ({
        id: newId(),
        facilityId: null,
        code: service.code,
        name: service.name,
        kind: service.kind,
        defaultPrice: service.defaultPrice,
        createdBy: "seed",
      })),
    );
  }

  const serviceRows = await db
    .select({ id: services.id, code: services.code, defaultPrice: services.defaultPrice })
    .from(services)
    .where(and(isNull(services.facilityId), inArray(services.code, serviceCodes)));

  const priceListIds = new Map<SeedPayerType, string>();
  for (const payer of PAYER_TYPES) {
    const [row] = await db
      .insert(priceLists)
      .values({
        id: newId(),
        facilityId,
        name: `${payer === "cash" ? "Cash" : payer === "sha" ? "SHA" : "Insurance"} price list`,
        payerType: payer,
        createdBy: "seed",
      })
      .onConflictDoUpdate({
        target: [priceLists.facilityId, priceLists.payerType],
        set: { active: true, updatedAt: new Date() },
      })
      .returning({ id: priceLists.id });
    priceListIds.set(payer, row.id);
  }

  const itemRows = await db
    .select({ id: items.id, code: items.code })
    .from(items)
    .where(inArray(items.code, DRUG_SEEDS.map((drug) => drug.code)));

  const existingPrices = await db
    .select({ priceListId: prices.priceListId, serviceId: prices.serviceId, itemId: prices.itemId })
    .from(prices)
    .where(eq(prices.facilityId, facilityId));
  const knownPrices = new Set(
    existingPrices.map((row) => `${row.priceListId}:${row.serviceId ?? row.itemId}`),
  );

  const pending: Array<{
    id: string;
    facilityId: string;
    priceListId: string;
    serviceId: string | null;
    itemId: string | null;
    amount: string;
    createdBy: string;
  }> = [];

  for (const payer of PAYER_TYPES) {
    const priceListId = priceListIds.get(payer);
    if (!priceListId) continue;

    for (const service of serviceRows) {
      if (knownPrices.has(`${priceListId}:${service.id}`)) continue;
      pending.push({
        id: newId(),
        facilityId,
        priceListId,
        serviceId: service.id,
        itemId: null,
        amount: payerPrice(service.defaultPrice, payer),
        createdBy: "seed",
      });
    }

    for (const item of itemRows) {
      if (knownPrices.has(`${priceListId}:${item.id}`)) continue;
      pending.push({
        id: newId(),
        facilityId,
        priceListId,
        serviceId: null,
        itemId: item.id,
        amount: payerPrice(DRUG_PRICES[item.code] ?? "5.00", payer),
        createdBy: "seed",
      });
    }
  }

  for (let index = 0; index < pending.length; index += 200) {
    await db.insert(prices).values(pending.slice(index, index + 200));
  }

  return {
    services: serviceRows.length,
    priceLists: priceListIds.size,
    prices: pending.length,
  };
}

function addDaysIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function seedQuantity(unit: string): number {
  if (unit === "tablet" || unit === "capsule") return 600;
  if (unit === "bottle" || unit === "tube" || unit === "inhaler") return 60;
  if (unit === "bag" || unit === "sachet") return 120;
  return 100;
}

/**
 * Give every seeded medicine one live batch in the pharmacy store so the
 * dispense queue has stock on a fresh install. Re-running the seed tops the
 * same batch up only once (a ledger row with note `seed` marks it).
 */
async function upsertPharmacyStock(
  db: ReturnType<typeof createDatabase>["db"],
  facilityId: string,
) {
  const storeRows = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.facilityId, facilityId), eq(stores.kind, "pharmacy")))
    .limit(1);
  const store = storeRows[0];
  if (!store) return { storeId: null, batches: 0, received: 0 };

  const itemRows = await db
    .select({ id: items.id, unit: items.unit })
    .from(items)
    .where(inArray(items.code, DRUG_SEEDS.map((drug) => drug.code)));

  let batches = 0;
  let received = 0;
  for (const item of itemRows) {
    const [batch] = await db
      .insert(itemBatches)
      .values({
        id: newId(),
        facilityId,
        itemId: item.id,
        batchNo: "SEED-2026-A",
        expiryDate: addDaysIso(365),
        unitCost: "2.50",
        createdBy: "seed",
      })
      .onConflictDoUpdate({
        target: [itemBatches.facilityId, itemBatches.itemId, itemBatches.batchNo],
        set: { expiryDate: sql`excluded.expiry_date`, updatedAt: new Date() },
      })
      .returning({ id: itemBatches.id });
    batches += 1;

    const existing = await db
      .select({ id: stockLedger.id })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.facilityId, facilityId),
          eq(stockLedger.storeId, store.id),
          eq(stockLedger.batchId, batch.id),
          eq(stockLedger.reason, "receive"),
          eq(stockLedger.note, "seed"),
        ),
      )
      .limit(1);
    if (existing[0]) continue;

    await db.insert(stockLedger).values({
      id: newId(),
      facilityId,
      storeId: store.id,
      itemId: item.id,
      batchId: batch.id,
      qtyDelta: seedQuantity(item.unit),
      reason: "receive",
      refType: "seed",
      note: "seed",
      createdBy: "seed",
    });
    received += 1;
  }

  return { storeId: store.id, batches, received };
}


async function upsertFacility(db: ReturnType<typeof createDatabase>["db"]) {
  const existing = await db
    .select()
    .from(facilities)
    .where(eq(facilities.code, FACILITY_CODE))
    .limit(1);

  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(facilities)
    .values({
      id: newId(),
      code: FACILITY_CODE,
      name: FACILITY_NAME,
      county: FACILITY_COUNTY,
      writeAuthority: APP_MODE === "clinic" ? "clinic" : "cloud",
      timezone: "Africa/Nairobi",
      createdBy: "seed",
    })
    .onConflictDoNothing({ target: facilities.code })
    .returning();

  if (inserted[0]) return inserted[0];

  const raced = await db
    .select()
    .from(facilities)
    .where(eq(facilities.code, FACILITY_CODE))
    .limit(1);
  if (!raced[0]) throw new Error("Facility seed failed");
  return raced[0];
}

async function upsertRegulatoryProfile(
  db: ReturnType<typeof createDatabase>["db"],
  facilityId: string,
) {
  const existing = await db
    .select({ facilityId: facilityRegulatoryProfiles.facilityId })
    .from(facilityRegulatoryProfiles)
    .where(eq(facilityRegulatoryProfiles.facilityId, facilityId))
    .limit(1);
  if (existing[0]) return { created: false };

  await db.insert(facilityRegulatoryProfiles).values({
    facilityId,
    // Only confirmed values are seeded. Everything else stays null and is
    // reported as `missing` for the administrator to fill in.
    kmpdcNumber: null,
    kmhflId: null,
    kephLevel: null,
    facilityCategory: "medical_centre",
    ownership: null,
    county: "Nairobi",
    subCounty: null,
    licenceNo: null,
    licenceIssueDate: null,
    licenceExpiryDate: null,
    licenceStatus: "pending",
    shaFacilityCode: null,
    shaEmpanelmentStatus: null,
    odpcRegistrationNo: null,
    odpcCategory: null,
    odpcExpiryDate: null,
    kraPin: "P052292910Q",
    tccNo: null,
    tccExpiryDate: null,
    nssfEmployerCode: null,
    shifEmployerCode: null,
    kemsaSupplierCode: null,
    updatedBy: "seed",
    createdBy: "seed",
  });

  return { created: true };
}

async function upsertBranch(db: ReturnType<typeof createDatabase>["db"], facilityId: string) {
  const existing = await db
    .select()
    .from(branches)
    .where(eq(branches.facilityId, facilityId))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(branches)
    .values({
      id: newId(),
      facilityId,
      code: BRANCH_CODE,
      name: BRANCH_NAME,
      isMain: true,
      createdBy: "seed",
    })
    .onConflictDoNothing({ target: [branches.facilityId, branches.code] })
    .returning();

  if (inserted[0]) return inserted[0];

  const raced = await db
    .select()
    .from(branches)
    .where(eq(branches.facilityId, facilityId))
    .limit(1);
  if (!raced[0]) throw new Error("Branch seed failed");
  return raced[0];
}

/**
 * Seed the default chart so billing, claims and the finance workspace have the
 * system accounts they resolve at posting time. Idempotent: an existing chart
 * is never overwritten.
 */
async function upsertChartOfAccounts(
  db: ReturnType<typeof createDatabase>["db"],
  facilityId: string,
  branchId: string,
) {
  let accounts = 0;
  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    const inserted = await db
      .insert(ledgerAccounts)
      .values({
        id: newId(),
        facilityId,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: normalBalanceFor(account.type),
        systemRole: account.systemRole,
        createdBy: "seed",
      })
      .onConflictDoNothing({ target: [ledgerAccounts.facilityId, ledgerAccounts.code] })
      .returning({ id: ledgerAccounts.id });
    accounts += inserted.length;
  }

  const centers = await db
    .insert(costCenters)
    .values({
      id: newId(),
      facilityId,
      branchId,
      code: DEFAULT_COST_CENTER.code,
      name: DEFAULT_COST_CENTER.name,
      createdBy: "seed",
    })
    .onConflictDoNothing({ target: [costCenters.facilityId, costCenters.code] })
    .returning({ id: costCenters.id });

  return { accounts, costCenters: centers.length };
}

async function upsertStaff(
  db: ReturnType<typeof createDatabase>["db"],
  facilityId: string,
  branchId: string,
) {
  const passwordHash = await hashPassword(STAFF_PASSWORD);

  for (const staff of STAFF_SEEDS) {
    const existing = await db.select().from(user).where(eq(user.email, staff.email)).limit(1);
    if (existing[0]) continue;

    const userId = newId();
    const now = new Date();

    await db.insert(user).values({
      id: userId,
      name: staff.name,
      email: staff.email,
      emailVerified: true,
      role: staff.role,
      banned: false,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(account).values({
      id: newId(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(staffProfiles).values({
      id: newId(),
      userId,
      staffNumber: staff.staffNumber,
      phone: "0700000000",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(staffRoleScopes).values({
      id: newId(),
      userId,
      role: staff.role,
      facilityId,
      branchId: null,
      createdAt: now,
    });

    await recordAudit(db, {
      facilityId,
      userId,
      action: "staff.seed",
      module: "admin",
      entity: "staff_profiles",
      entityId: userId,
      details: { role: staff.role, staffNumber: staff.staffNumber },
      deviceId: "seed-script",
    });
  }

  return { branchId, count: STAFF_SEEDS.length, password: STAFF_PASSWORD };
}

/**
 * Tax and eTIMS defaults. Existing rows win, except the invoice prefix: the
 * Kenya readiness spec requires FAH, so an older seeded value is corrected.
 */
async function seedTaxDefaults(
  db: ReturnType<typeof createDatabase>["db"],
  facilityId: string,
) {
  await db
    .update(facilitySettings)
    .set({ valueText: "FAH", updatedAt: new Date() })
    .where(
      and(
        eq(facilitySettings.facilityId, facilityId),
        eq(facilitySettings.domain, "tax"),
        eq(facilitySettings.key, "invoice_prefix"),
        ne(facilitySettings.valueText, "FAH"),
      ),
    );

  const codes = [
    {
      code: "VAT_STANDARD",
      name: "VAT 16%",
      rate: "16.0000",
      treatment: "vat_standard" as const,
      kraCode: "VAT",
      isDefault: true,
    },
    {
      code: "VAT_ZERO",
      name: "VAT zero-rated",
      rate: "0.0000",
      treatment: "vat_zero" as const,
      kraCode: "ZERO",
      isDefault: false,
    },
    {
      code: "EXEMPT",
      name: "VAT exempt",
      rate: "0.0000",
      treatment: "exempt" as const,
      kraCode: "EXEMPT",
      isDefault: false,
    },
    {
      code: "OUT_OF_SCOPE",
      name: "Out of scope",
      rate: "0.0000",
      treatment: "out_of_scope" as const,
      kraCode: null,
      isDefault: false,
    },
  ];

  const insertedCodes = await db
    .insert(taxCodes)
    .values(
      codes.map((code) => ({
        id: newId(),
        facilityId,
        code: code.code,
        name: code.name,
        rate: code.rate,
        treatment: code.treatment,
        kraCode: code.kraCode,
        effectiveFrom: "2000-01-01",
        active: true,
        isDefault: code.isDefault,
        createdBy: "seed",
      })),
    )
    .onConflictDoNothing({ target: [taxCodes.facilityId, taxCodes.code, taxCodes.effectiveFrom] })
    .returning({ id: taxCodes.id });

  const integrations = await db
    .insert(integrationSettings)
    .values([
      {
        id: newId(),
        facilityId,
        integration: "etims",
        environment: "sandbox",
        baseUrl: ETIMS_SANDBOX_STUB_URL,
        mode: "oscu",
        specVersion: "oscu-1.0",
        credentialRef: "ETIMS_SANDBOX_API_KEY",
        timeoutMs: 30_000,
        maxAttempts: 5,
        backoffSeconds: [1, 2, 4, 8, 16],
        enabled: true,
        lastVerifiedAt: null,
        createdBy: "seed",
      },
      {
        id: newId(),
        facilityId,
        integration: "etims",
        environment: "production",
        baseUrl: process.env.ETIMS_PRODUCTION_BASE_URL || "https://etims.kra.example/production",
        mode: "oscu",
        specVersion: "oscu-1.0",
        credentialRef: "ETIMS_PRODUCTION_API_KEY",
        timeoutMs: 30_000,
        maxAttempts: 5,
        backoffSeconds: [30, 120, 600, 1800, 3600],
        enabled: false,
        lastVerifiedAt: null,
        createdBy: "seed",
      },
    ])
    .onConflictDoNothing({
      target: [
        integrationSettings.facilityId,
        integrationSettings.integration,
        integrationSettings.environment,
      ],
    })
    .returning({ id: integrationSettings.id });

  return { codesSeeded: insertedCodes.length, integrationsSeeded: integrations.length };
}

async function seed() {
  const { pool, db } = createDatabase(DATABASE_URL);

  try {
    const facility = await upsertFacility(db);
    const branch = await upsertBranch(db, facility.id);
    const chart = await upsertChartOfAccounts(db, facility.id, branch.id);
    const staff = await upsertStaff(db, facility.id, branch.id);
    const regulatory = await upsertRegulatoryProfile(db, facility.id);
    const settingsSeeded = await seedRegulatoryDefaults(db, facility.id);
    const tax = await seedTaxDefaults(db, facility.id);

    const syncToken = process.env.FACILITY_SYNC_TOKEN;
    const syncDeviceKey = process.env.FACILITY_DEVICE_KEY?.trim() || "clinic-server";
    if (syncToken && syncToken.length >= 16) {
      await db
        .insert(facilitySyncTokens)
        .values({
          facilityId: facility.id,
          deviceKey: syncDeviceKey,
          tokenHash: hashSyncToken(syncToken),
          active: true,
        })
        .onConflictDoNothing({ target: [facilitySyncTokens.facilityId, facilitySyncTokens.deviceKey] });
    }

    const icd10 = await upsertIcd10(db);
    const labCatalog = await upsertLabTests(db);
    const drugCatalog = await upsertDrugs(db);
    const billing = await upsertBillingCatalog(db, facility.id);

    const storeSeeds = [
      { name: "Pharmacy", kind: "pharmacy" as const },
      { name: "Main Store", kind: "main" as const },
      { name: "Lab", kind: "lab" as const },
    ];

    for (const store of storeSeeds) {
      await db
        .insert(stores)
        .values({
          id: newId(),
          facilityId: facility.id,
          branchId: branch.id,
          name: store.name,
          kind: store.kind,
          createdBy: "seed",
        })
        .onConflictDoNothing({
          target: [stores.facilityId, stores.branchId, stores.name],
        });
    }

    const allStores = await db.select().from(stores).where(eq(stores.facilityId, facility.id));
    const pharmacyStock = await upsertPharmacyStock(db, facility.id);

    console.log(
      JSON.stringify(
        {
          facility: { id: facility.id, code: facility.code, name: facility.name },
          branch: { id: branch.id, code: branch.code, name: branch.name },
          stores: allStores.map(({ id, name, kind }) => ({ id, name, kind })),
          staff: { count: staff.count, password: staff.password },
          chartOfAccounts: chart,
          catalog: { icd10, labTests: labCatalog, drugs: drugCatalog },
          billing,
          pharmacyStock,
          regulatory: { ...regulatory, settingsSeeded },
          tax,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
