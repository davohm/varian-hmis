/**
 * One-off provisioning of the real FAM operating structure.
 *
 * FAM is clinic-authority, so the supported write path is the branch node in
 * APP_MODE=clinic. Every write goes through a server-side command (idempotency
 * key + audit row + outbox row) and the sync worker mirrors the result to the
 * cloud admin. Nothing here writes with raw SQL or bypasses write authority.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import {
  createDepartment,
  createItem,
  createLabTest,
  createPriceList,
  createRoom,
  createService,
  createStore,
  upsertPrice,
} from "../src/server/commands/admin";
import { createDatabase } from "../src/server/db/client";
import {
  departments,
  items,
  labTests,
  priceLists,
  prices,
  rooms,
  services,
  stores,
} from "../src/server/db/schema";

const FACILITY_ID = "01a1fda9-b1d1-717a-9fe0-c3b523d937ec";
const BRANCH_ID = "01a1fda9-bce4-7e3b-b74e-7249aa2e64cb";
const ADMIN_ID = "01a1fda9-c93c-72c5-95d7-321f74c07f25";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) throw new Error("DIRECT_DATABASE_URL must be set to the branch database");

const { db, pool } = createDatabase(url, "clinic");
const options = { database: db, mode: "clinic" as const };
const actor = { userId: ADMIN_ID, ip: "127.0.0.1", deviceId: "fam-structure-provisioner" };
const base = () => ({ facilityId: FACILITY_ID, idempotencyKey: randomUUID(), actor });

let created = 0;
let existing = 0;

function note(_label: string, wasCreated: boolean) {
  if (wasCreated) created += 1;
  else existing += 1;
  if ((created + existing) % 25 === 0) {
    console.log(JSON.stringify({ progress: created + existing, created, existing }));
  }
}

async function ensureDepartment(name: string, kind: "opd" | "triage" | "reception" | "lab" | "pharmacy" | "cashier" | "admin" | "other") {
  const found = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.facilityId, FACILITY_ID), eq(departments.branchId, BRANCH_ID), eq(departments.name, name)))
    .limit(1);
  if (found[0]) {
    note(`department ${name}`, false);
    return found[0].id;
  }
  const result = await createDepartment({ ...base(), branchId: BRANCH_ID, name, kind }, options);
  note(`department ${name}`, true);
  return result.departmentId;
}

async function ensureRoom(departmentId: string, name: string) {
  const found = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.facilityId, FACILITY_ID), eq(rooms.departmentId, departmentId), eq(rooms.name, name)))
    .limit(1);
  if (found[0]) {
    note(`room ${name}`, false);
    return found[0].id;
  }
  const result = await createRoom({ ...base(), departmentId, name }, options);
  note(`room ${name}`, true);
  return result.roomId;
}

async function ensureStore(name: string, kind: "pharmacy" | "main" | "lab") {
  const found = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.facilityId, FACILITY_ID), eq(stores.branchId, BRANCH_ID), eq(stores.name, name)))
    .limit(1);
  if (found[0]) {
    note(`store ${name}`, false);
    return found[0].id;
  }
  const result = await createStore({ ...base(), branchId: BRANCH_ID, name, kind }, options);
  note(`store ${name}`, true);
  return result.storeId;
}

type ItemSpec = {
  code: string;
  name: string;
  kind: "drug" | "consumable" | "reagent";
  unit: string;
  strength?: string;
  form?: string;
  cashPrice?: string;
};

async function ensureItem(spec: ItemSpec) {
  const found = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.facilityId, FACILITY_ID), eq(items.code, spec.code)))
    .limit(1);
  if (found[0]) {
    note(`item ${spec.code}`, false);
    return found[0].id;
  }
  const result = await createItem(
    {
      ...base(),
      code: spec.code,
      name: spec.name,
      kind: spec.kind,
      unit: spec.unit,
      strength: spec.strength ?? null,
      form: spec.form ?? null,
      shared: false,
    },
    options,
  );
  note(`item ${spec.code}`, true);
  return result.itemId;
}

type LabSpec = {
  code: string;
  name: string;
  sampleType: string;
  parameters: Array<{ name: string; unit: string; refLow?: number; refHigh?: number }>;
};

async function ensureLabTest(spec: LabSpec) {
  const found = await db
    .select({ id: labTests.id })
    .from(labTests)
    .where(and(eq(labTests.facilityId, FACILITY_ID), eq(labTests.code, spec.code)))
    .limit(1);
  if (found[0]) {
    note(`lab ${spec.code}`, false);
    return found[0].id;
  }
  const result = await createLabTest(
    {
      ...base(),
      code: spec.code,
      name: spec.name,
      sampleType: spec.sampleType,
      parameters: spec.parameters.map((p) => ({
        name: p.name,
        unit: p.unit,
        refLow: p.refLow ?? null,
        refHigh: p.refHigh ?? null,
        criticalLow: null,
        criticalHigh: null,
      })),
      shared: false,
    },
    options,
  );
  note(`lab ${spec.code}`, true);
  return result.labTestId;
}

type ServiceSpec = {
  code: string;
  name: string;
  kind: "consultation" | "lab" | "procedure" | "drug";
  cash: string;
  sha: string;
  insurance: string;
};

async function ensureService(spec: ServiceSpec) {
  const found = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.facilityId, FACILITY_ID), eq(services.code, spec.code)))
    .limit(1);
  if (found[0]) {
    note(`service ${spec.code}`, false);
    return found[0].id;
  }
  const result = await createService(
    {
      ...base(),
      code: spec.code,
      name: spec.name,
      kind: spec.kind,
      defaultPrice: spec.cash,
      active: true,
      shared: false,
    },
    options,
  );
  note(`service ${spec.code}`, true);
  return result.serviceId;
}

async function ensurePriceList(name: string, payerType: "cash" | "sha" | "insurance") {
  const found = await db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.facilityId, FACILITY_ID), eq(priceLists.payerType, payerType)))
    .limit(1);
  if (found[0]) {
    note(`price list ${payerType}`, false);
    return found[0].id;
  }
  const result = await createPriceList({ ...base(), name, payerType, active: true }, options);
  note(`price list ${payerType}`, true);
  return result.priceListId;
}

async function ensureServicePrice(priceListId: string, serviceId: string, amount: string) {
  const found = await db
    .select({ id: prices.id })
    .from(prices)
    .where(and(eq(prices.priceListId, priceListId), eq(prices.serviceId, serviceId)))
    .limit(1);
  if (found[0]) return;
  await upsertPrice({ ...base(), priceListId, targetType: "service", targetId: serviceId, amount }, options);
  note("service price", true);
}

async function ensureItemPrice(priceListId: string, itemId: string, amount: string) {
  const found = await db
    .select({ id: prices.id })
    .from(prices)
    .where(and(eq(prices.priceListId, priceListId), eq(prices.itemId, itemId)))
    .limit(1);
  if (found[0]) return;
  await upsertPrice({ ...base(), priceListId, targetType: "item", targetId: itemId, amount }, options);
  note("item price", true);
}

async function main() {
  console.log(JSON.stringify({ phase: "departments" }));
  const deptSpecs = [
    ["Reception", "reception"],
    ["Triage", "triage"],
    ["Outpatient Department", "opd"],
    ["Laboratory", "lab"],
    ["Pharmacy", "pharmacy"],
    ["Cashier", "cashier"],
    ["Administration", "admin"],
    ["Minor Theatre", "other"],
  ] as const;
  const deptIds: Record<string, string> = {};
  for (const [name, kind] of deptSpecs) deptIds[name] = await ensureDepartment(name, kind);

  console.log(JSON.stringify({ phase: "rooms" }));
  const roomSpecs: Array<[string, string[]]> = [
    ["Reception", ["Front Desk", "Medical Records Desk"]],
    ["Triage", ["Triage Bay 1", "Triage Bay 2", "Observation Bay"]],
    ["Outpatient Department", ["Consultation Room 1", "Consultation Room 2", "Consultation Room 3", "Consultation Room 4"]],
    ["Laboratory", ["Lab Reception", "Haematology Bench", "Biochemistry Bench", "Microbiology Bench"]],
    ["Pharmacy", ["Dispensing Counter 1", "Dispensing Counter 2"]],
    ["Cashier", ["Cashier Counter 1", "Cashier Counter 2"]],
    ["Administration", ["Administrator Office", "Records Office"]],
    ["Minor Theatre", ["Procedure Room 1", "Recovery Bay"]],
  ];
  for (const [dept, names] of roomSpecs) {
    for (const name of names) await ensureRoom(deptIds[dept], name);
  }

  console.log(JSON.stringify({ phase: "stores" }));
  await ensureStore("Pharmacy", "pharmacy");
  await ensureStore("Main Store", "main");
  await ensureStore("Laboratory Store", "lab");

  console.log(JSON.stringify({ phase: "items" }));
  const itemSpecs: ItemSpec[] = [
    { code: "PARA500", name: "Paracetamol 500mg tablet", kind: "drug", unit: "tablet", strength: "500mg", form: "tablet", cashPrice: "20.00" },
    { code: "AMOX500", name: "Amoxicillin 500mg capsule", kind: "drug", unit: "capsule", strength: "500mg", form: "capsule", cashPrice: "60.00" },
    { code: "ARTEM20", name: "Artemether/Lumefantrine 20/120mg tablet", kind: "drug", unit: "tablet", strength: "20/120mg", form: "tablet", cashPrice: "120.00" },
    { code: "CIP500", name: "Ciprofloxacin 500mg tablet", kind: "drug", unit: "tablet", strength: "500mg", form: "tablet", cashPrice: "80.00" },
    { code: "AZITH500", name: "Azithromycin 500mg tablet", kind: "drug", unit: "tablet", strength: "500mg", form: "tablet", cashPrice: "150.00" },
    { code: "MET500", name: "Metformin 500mg tablet", kind: "drug", unit: "tablet", strength: "500mg", form: "tablet", cashPrice: "30.00" },
    { code: "AMLO5", name: "Amlodipine 5mg tablet", kind: "drug", unit: "tablet", strength: "5mg", form: "tablet", cashPrice: "35.00" },
    { code: "OMEP20", name: "Omeprazole 20mg capsule", kind: "drug", unit: "capsule", strength: "20mg", form: "capsule", cashPrice: "55.00" },
    { code: "ORS", name: "Oral Rehydration Salts sachet", kind: "drug", unit: "sachet", cashPrice: "40.00" },
    { code: "NSALINE", name: "Normal Saline 0.9% 500ml infusion", kind: "drug", unit: "bottle", strength: "0.9%", form: "infusion", cashPrice: "350.00" },
    { code: "DICLO75", name: "Diclofenac 75mg injection", kind: "drug", unit: "ampoule", strength: "75mg", form: "injection", cashPrice: "120.00" },
    { code: "AMOXSYR", name: "Amoxicillin syrup 250mg/5ml", kind: "drug", unit: "bottle", strength: "250mg/5ml", form: "syrup", cashPrice: "280.00" },
    { code: "GLOVES", name: "Nitrile examination gloves (100s)", kind: "consumable", unit: "box", cashPrice: "900.00" },
    { code: "SYRINGE5", name: "Disposable syringe 5ml", kind: "consumable", unit: "piece", cashPrice: "25.00" },
    { code: "BANDAGE", name: "Crepe bandage 10cm", kind: "consumable", unit: "roll", cashPrice: "180.00" },
    { code: "GAUZE", name: "Sterile gauze swabs (100s)", kind: "consumable", unit: "pack", cashPrice: "450.00" },
    { code: "REAGFBC", name: "Full blood count reagent kit", kind: "reagent", unit: "kit" },
    { code: "RDTMAL", name: "Malaria rapid diagnostic test", kind: "reagent", unit: "test" },
  ];
  const itemIds: Record<string, string> = {};
  for (const spec of itemSpecs) itemIds[spec.code] = await ensureItem(spec);

  console.log(JSON.stringify({ phase: "lab-tests" }));
  const labSpecs: LabSpec[] = [
    { code: "FBC", name: "Full Blood Count", sampleType: "Whole blood (EDTA)", parameters: [
      { name: "Haemoglobin", unit: "g/dL", refLow: 12, refHigh: 17 },
      { name: "White cell count", unit: "x10^9/L", refLow: 4, refHigh: 11 },
      { name: "Platelets", unit: "x10^9/L", refLow: 150, refHigh: 400 },
      { name: "Haematocrit", unit: "%", refLow: 36, refHigh: 50 },
      { name: "MCV", unit: "fL", refLow: 80, refHigh: 100 },
    ] },
    { code: "MP", name: "Malaria Parasite", sampleType: "Whole blood (EDTA)", parameters: [
      { name: "Malaria parasite", unit: "result" },
    ] },
    { code: "RBS", name: "Random Blood Sugar", sampleType: "Capillary whole blood", parameters: [
      { name: "Glucose", unit: "mmol/L", refLow: 3.9, refHigh: 7.8 },
    ] },
    { code: "HBA1C", name: "Glycated Haemoglobin (HbA1c)", sampleType: "Whole blood (EDTA)", parameters: [
      { name: "HbA1c", unit: "%", refLow: 4, refHigh: 5.6 },
    ] },
    { code: "UEC", name: "Urea, Electrolytes and Creatinine", sampleType: "Serum", parameters: [
      { name: "Urea", unit: "mmol/L", refLow: 2.5, refHigh: 7.1 },
      { name: "Sodium", unit: "mmol/L", refLow: 135, refHigh: 145 },
      { name: "Potassium", unit: "mmol/L", refLow: 3.5, refHigh: 5.1 },
      { name: "Creatinine", unit: "umol/L", refLow: 62, refHigh: 106 },
    ] },
    { code: "LFT", name: "Liver Function Tests", sampleType: "Serum", parameters: [
      { name: "ALT", unit: "U/L", refLow: 7, refHigh: 55 },
      { name: "AST", unit: "U/L", refLow: 8, refHigh: 48 },
      { name: "ALP", unit: "U/L", refLow: 40, refHigh: 129 },
      { name: "Total bilirubin", unit: "umol/L", refLow: 3, refHigh: 21 },
      { name: "Albumin", unit: "g/L", refLow: 35, refHigh: 50 },
    ] },
    { code: "URIN", name: "Urinalysis", sampleType: "Midstream urine", parameters: [
      { name: "Protein", unit: "result" },
      { name: "Glucose", unit: "result" },
      { name: "Blood", unit: "result" },
    ] },
    { code: "PREG", name: "Pregnancy Test", sampleType: "Urine", parameters: [
      { name: "hCG", unit: "result" },
    ] },
    { code: "TSH", name: "Thyroid Stimulating Hormone", sampleType: "Serum", parameters: [
      { name: "TSH", unit: "mIU/L", refLow: 0.4, refHigh: 4 },
    ] },
    { code: "HIV", name: "HIV Screening Test", sampleType: "Serum", parameters: [
      { name: "HIV antibody", unit: "result" },
    ] },
    { code: "HBSAG", name: "Hepatitis B Surface Antigen", sampleType: "Serum", parameters: [
      { name: "HBsAg", unit: "result" },
    ] },
    { code: "WIDAL", name: "Widal Test", sampleType: "Serum", parameters: [
      { name: "Salmonella typhi O", unit: " titre" },
      { name: "Salmonella typhi H", unit: " titre" },
    ] },
  ];
  for (const spec of labSpecs) await ensureLabTest(spec);

  console.log(JSON.stringify({ phase: "services" }));
  const serviceSpecs: ServiceSpec[] = [
    { code: "CONS", name: "General Consultation", kind: "consultation", cash: "500.00", sha: "450.00", insurance: "550.00" },
    { code: "REVIEW", name: "Follow-up Review", kind: "consultation", cash: "300.00", sha: "270.00", insurance: "330.00" },
    { code: "DRESS", name: "Wound Dressing", kind: "procedure", cash: "400.00", sha: "360.00", insurance: "440.00" },
    { code: "INJ", name: "Injection Administration", kind: "procedure", cash: "250.00", sha: "225.00", insurance: "275.00" },
    { code: "ECG", name: "Electrocardiogram", kind: "procedure", cash: "800.00", sha: "720.00", insurance: "880.00" },
    { code: "USCAN", name: "Ultrasound Scan", kind: "procedure", cash: "1500.00", sha: "1350.00", insurance: "1650.00" },
    { code: "VACC", name: "Vaccination", kind: "procedure", cash: "600.00", sha: "540.00", insurance: "660.00" },
    { code: "MINOR", name: "Minor Surgical Procedure", kind: "procedure", cash: "1200.00", sha: "1080.00", insurance: "1320.00" },
    { code: "LABFBC", name: "Full Blood Count (Lab)", kind: "lab", cash: "800.00", sha: "720.00", insurance: "880.00" },
    { code: "LABMP", name: "Malaria Parasite Test (Lab)", kind: "lab", cash: "500.00", sha: "450.00", insurance: "550.00" },
    { code: "LABRBS", name: "Random Blood Sugar (Lab)", kind: "lab", cash: "400.00", sha: "360.00", insurance: "440.00" },
    { code: "LABUEC", name: "Urea, Electrolytes and Creatinine (Lab)", kind: "lab", cash: "1200.00", sha: "1080.00", insurance: "1320.00" },
    { code: "LABLFT", name: "Liver Function Tests (Lab)", kind: "lab", cash: "1400.00", sha: "1260.00", insurance: "1540.00" },
    { code: "LABURIN", name: "Urinalysis (Lab)", kind: "lab", cash: "400.00", sha: "360.00", insurance: "440.00" },
    { code: "LABPREG", name: "Pregnancy Test (Lab)", kind: "lab", cash: "500.00", sha: "450.00", insurance: "550.00" },
    { code: "LABHBA1C", name: "HbA1c (Lab)", kind: "lab", cash: "1800.00", sha: "1620.00", insurance: "1980.00" },
  ];
  const serviceIds: Record<string, string> = {};
  for (const spec of serviceSpecs) serviceIds[spec.code] = await ensureService(spec);

  console.log(JSON.stringify({ phase: "prices" }));
  const cash = await ensurePriceList("Cash", "cash");
  const sha = await ensurePriceList("SHA", "sha");
  const insurance = await ensurePriceList("Insurance", "insurance");

  for (const spec of serviceSpecs) {
    const id = serviceIds[spec.code];
    await ensureServicePrice(cash, id, spec.cash);
    await ensureServicePrice(sha, id, spec.sha);
    await ensureServicePrice(insurance, id, spec.insurance);
  }
  for (const spec of itemSpecs) {
    if (!spec.cashPrice) continue;
    await ensureItemPrice(cash, itemIds[spec.code], spec.cashPrice);
  }

  console.log(JSON.stringify({ phase: "complete", created, existing }));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
