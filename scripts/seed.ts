import { hashPassword } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { newId } from "../src/lib/uuid";
import { recordAudit } from "../src/server/audit";
import { APP_MODE, DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import {
  account,
  branches,
  facilities,
  icd10Codes,
  items,
  labTests,
  staffProfiles,
  staffRoleScopes,
  stores,
  user,
  type LabParameter,
  type Role,
} from "../src/server/db/schema";

const FACILITY_CODE = "FAM";
const FACILITY_NAME = "Family Afya Modern Medical Centre";
const BRANCH_CODE = "MAIN";
const BRANCH_NAME = "Main Branch";
const STAFF_PASSWORD = "VarianHMIS2026!";

const STAFF_SEEDS: Array<{ role: Role; name: string; email: string; staffNumber: string }> = [
  { role: "receptionist", name: "Reception Officer", email: "receptionist@fam.test", staffNumber: "FAM-R001" },
  { role: "triage_nurse", name: "Triage Nurse", email: "triage@fam.test", staffNumber: "FAM-T001" },
  { role: "doctor", name: "Consulting Doctor", email: "doctor@fam.test", staffNumber: "FAM-D001" },
  { role: "lab_tech", name: "Laboratory Technician", email: "lab@fam.test", staffNumber: "FAM-L001" },
  { role: "pharmacist", name: "Pharmacist", email: "pharmacist@fam.test", staffNumber: "FAM-P001" },
  { role: "cashier", name: "Cashier", email: "cashier@fam.test", staffNumber: "FAM-C001" },
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
      county: "Nairobi",
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

async function seed() {
  const { pool, db } = createDatabase(DATABASE_URL);

  try {
    const facility = await upsertFacility(db);
    const branch = await upsertBranch(db, facility.id);
    const staff = await upsertStaff(db, facility.id, branch.id);
    const icd10 = await upsertIcd10(db);
    const labCatalog = await upsertLabTests(db);
    const drugCatalog = await upsertDrugs(db);

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

    console.log(
      JSON.stringify(
        {
          facility: { id: facility.id, code: facility.code, name: facility.name },
          branch: { id: branch.id, code: branch.code, name: branch.name },
          stores: allStores.map(({ id, name, kind }) => ({ id, name, kind })),
          staff: { count: staff.count, password: staff.password },
          catalog: { icd10, labTests: labCatalog, drugs: drugCatalog },
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
