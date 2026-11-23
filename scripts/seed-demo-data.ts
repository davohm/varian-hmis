/**
 * Seed a local-only DEMO facility with realistic workflow data.
 *
 * Safety:
 * - Uses local DATABASE_URL only (process.env or .env.local).
 * - Never prints secrets or connection strings.
 * - Creates a dedicated REGDEMO-* facility so runCommand suppresses outbox capture.
 * - Uses command APIs for clinical/financial writes (audit/outbox behavior).
 * - Idempotent via deterministic command idempotency keys and existence checks.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";

import { ADMIN_SECTIONS } from "../src/lib/admin-sections";
import { createDatabase } from "../src/server/db/client";
import { upsertPrice } from "../src/server/commands/admin/catalog";
import { openCashierSession, openInvoice, takePayment } from "../src/server/commands/billing";
import {
  orderLabTests,
  prescribe,
  recordDiagnosis,
  saveClinicalNote,
  startConsultation,
} from "../src/server/commands/clinical";
import { startVisit } from "../src/server/commands/encounters";
import {
  collectLabSample,
  enterLabResults,
  startLabProcessing,
  verifyLabResults,
} from "../src/server/commands/lab";
import { registerPatient } from "../src/server/commands/patients";
import { recordConsent } from "../src/server/commands/privacy";
import { dispensePrescription, receiveStock } from "../src/server/commands/pharmacy";
import { queuePatient } from "../src/server/commands/queue";
import {
  createPayer,
  createPayerBenefit,
  createPayerContract,
} from "../src/server/commands/revenue";
import {
  loadRegulatoryTestPlaceholders,
  upsertFacilityRegulatoryProfile,
  upsertShaAdjudicationCode,
} from "../src/server/commands/regulatory";
import {
  createBenefitPackage,
  createEmpanelment,
  createShaClaim,
  recordShaAdjudication,
  recordShaRemittance,
  reconcileShaPaymentReport,
  submitShaClaim,
  verifyShaEligibility,
} from "../src/server/commands/sha";
import { recordTriageVitals } from "../src/server/commands/triage";
import {
  adminSectionPermissions,
  branches,
  commandLog,
  departments,
  facilities,
  invoices,
  items,
  labTests,
  ledgerAccounts,
  patients,
  priceLists,
  rooms,
  services,
  staffProfiles,
  staffRoleScopes,
  stores,
  user,
} from "../src/server/db/schema";
import { seedRegulatoryDefaults } from "../src/server/regulatory-seed";

type Db = ReturnType<typeof createDatabase>["db"];

const FACILITY_CODE = "REGDEMO-CLINICAL-001";
const FACILITY_NAME = "DEMO - Clinical Workflow Sandbox (not real FAM)";
const BRANCH_CODE = "DEMO-MAIN";
const BRANCH_NAME = "DEMO Main Branch";
const DEMO_MARKER = "[DEMO]";
const TODAY = new Date().toISOString().slice(0, 10);

const ACTORS = {
  admin: { userId: "demo-regdemo-admin", deviceId: "seed-demo-data" },
  receptionist: { userId: "demo-regdemo-reception", deviceId: "seed-demo-data" },
  nurse: { userId: "demo-regdemo-nurse", deviceId: "seed-demo-data" },
  doctor: { userId: "demo-regdemo-doctor", deviceId: "seed-demo-data" },
  lab: { userId: "demo-regdemo-lab", deviceId: "seed-demo-data" },
  pharmacist: { userId: "demo-regdemo-pharmacy", deviceId: "seed-demo-data" },
  cashier: { userId: "demo-regdemo-cashier", deviceId: "seed-demo-data" },
  shaSubmitter: { userId: "demo-regdemo-sha-submit", deviceId: "seed-demo-data" },
  shaAdjudicator: { userId: "demo-regdemo-sha-adjudicate", deviceId: "seed-demo-data" },
  shaRemitter: { userId: "demo-regdemo-sha-remit", deviceId: "seed-demo-data" },
} as const;

type Skip = { step: string; reason: string };
type Summary = {
  facilityCode: string;
  facilityId: string;
  created: Record<string, number>;
  skipped: Skip[];
};

function readEnvFile(path: string): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function readDatabaseUrl(): string {
  const fromProcess = process.env.DATABASE_URL?.trim();
  if (fromProcess) return fromProcess;
  const local = readEnvFile(".env.local").DATABASE_URL?.trim();
  if (local) return local;
  const env = readEnvFile(".env").DATABASE_URL?.trim();
  if (env) return env;
  throw new Error(
    "DATABASE_URL is required. Set it in the environment or in .env.local before running db:seed:demo.",
  );
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; // version 5-shaped nibble; value is deterministic, not RFC namespace-based
  const variant = parseInt(hex[16], 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function key(step: string): string {
  return deterministicUuid(`varian-demo:${FACILITY_CODE}:${step}`);
}

function id(seed: string): string {
  return deterministicUuid(`varian-demo-id:${FACILITY_CODE}:${seed}`);
}

async function getCommandResult<T>(db: Db, facilityId: string, idempotencyKey: string): Promise<T | null> {
  const rows = await db
    .select({ result: commandLog.result, command: commandLog.command })
    .from(commandLog)
    .where(and(eq(commandLog.facilityId, facilityId), eq(commandLog.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (!rows[0]) return null;
  return rows[0].result as T;
}

async function ensureUser(tx: Db, userId: string, name: string, email: string) {
  const existing = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (existing[0]) return false;
  await tx.insert(user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: "user",
    banned: false,
  });
  return true;
}

async function ensureStaff(
  tx: Db,
  facilityId: string,
  input: {
    userId: string;
    name: string;
    email: string;
    staffNumber: string;
    role: (typeof staffRoleScopes.$inferInsert)["role"];
  },
) {
  const created = { user: false, profile: false, role: false };
  created.user = await ensureUser(tx, input.userId, input.name, input.email);

  const profileRows = await tx
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(eq(staffProfiles.userId, input.userId))
    .limit(1);
  let staffProfileId = profileRows[0]?.id;
  if (!staffProfileId) {
    staffProfileId = id(`staff-profile:${input.userId}`);
    await tx.insert(staffProfiles).values({
      id: staffProfileId,
      userId: input.userId,
      staffNumber: input.staffNumber,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    created.profile = true;
  }

  const roleRows = await tx
    .select({ id: staffRoleScopes.id })
    .from(staffRoleScopes)
    .where(
      and(
        eq(staffRoleScopes.userId, input.userId),
        eq(staffRoleScopes.facilityId, facilityId),
        eq(staffRoleScopes.role, input.role),
        sql`${staffRoleScopes.branchId} is null`,
      ),
    )
    .limit(1);
  if (!roleRows[0]) {
    await tx.insert(staffRoleScopes).values({
      id: id(`role:${input.userId}:${input.role}:${facilityId}`),
      userId: input.userId,
      role: input.role,
      facilityId,
      branchId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    created.role = true;
  }

  return { staffProfileId, created };
}

async function main() {
  const databaseUrl = readDatabaseUrl();
  const { db, pool } = createDatabase(databaseUrl, "clinic");
  const summary: Summary = {
    facilityCode: FACILITY_CODE,
    facilityId: "",
    created: {},
    skipped: [],
  };
  const bump = (name: string, n = 1) => {
    summary.created[name] = (summary.created[name] ?? 0) + n;
  };
  const skip = (step: string, reason: string) => {
    summary.skipped.push({ step, reason });
  };

  try {
    const existingFacility = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.code, FACILITY_CODE))
      .limit(1);
    const facilityId = existingFacility[0]?.id ?? id("facility");
    summary.facilityId = facilityId;

    let branchId = "";
    let triageRoomId = "";
    let pharmacyStoreId = "";

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);

      if (!existingFacility[0]) {
        await tx.insert(facilities).values({
          id: facilityId,
          code: FACILITY_CODE,
          name: FACILITY_NAME,
          county: "DEMO COUNTY",
          writeAuthority: "clinic",
          active: true,
          createdBy: ACTORS.admin.userId,
          updatedAt: new Date(),
        });
        bump("facilities");
      } else {
        await tx
          .update(facilities)
          .set({
            name: FACILITY_NAME,
            county: "DEMO COUNTY",
            writeAuthority: "clinic",
            active: true,
            updatedAt: new Date(),
          })
          .where(eq(facilities.id, facilityId));
      }

      const branchRows = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.facilityId, facilityId), eq(branches.code, BRANCH_CODE)))
        .limit(1);
      branchId = branchRows[0]?.id ?? id("branch-main");
      if (!branchRows[0]) {
        await tx.insert(branches).values({
          id: branchId,
          facilityId,
          code: BRANCH_CODE,
          name: BRANCH_NAME,
          isMain: true,
          active: true,
          createdBy: ACTORS.admin.userId,
          updatedAt: new Date(),
        });
        bump("branches");
      }

      const ensureDept = async (code: string, name: string, kind: "reception" | "triage" | "opd" | "lab" | "pharmacy" | "cashier") => {
        const rows = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(and(eq(departments.facilityId, facilityId), eq(departments.branchId, branchId), eq(departments.name, name)))
          .limit(1);
        if (rows[0]) return rows[0].id;
        const deptId = id(`dept:${code}`);
        await tx.insert(departments).values({
          id: deptId,
          facilityId,
          branchId,
          name,
          kind,
          active: true,
          createdBy: ACTORS.admin.userId,
          updatedAt: new Date(),
        });
        bump("departments");
        return deptId;
      };

      const triageDeptId = await ensureDept("triage", "DEMO Triage", "triage");
      const opdDeptId = await ensureDept("opd", "DEMO Outpatient", "opd");
      await ensureDept("lab", "DEMO Laboratory", "lab");
      const pharmacyDeptId = await ensureDept("pharmacy", "DEMO Pharmacy", "pharmacy");
      await ensureDept("cashier", "DEMO Cashier", "cashier");

      const ensureRoom = async (departmentId: string, name: string, seed: string) => {
        const rows = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.facilityId, facilityId), eq(rooms.departmentId, departmentId), eq(rooms.name, name)))
          .limit(1);
        if (rows[0]) return rows[0].id;
        const roomId = id(seed);
        await tx.insert(rooms).values({
          id: roomId,
          facilityId,
          departmentId,
          name,
          active: true,
          createdBy: ACTORS.admin.userId,
          updatedAt: new Date(),
        });
        bump("rooms");
        return roomId;
      };
      triageRoomId = await ensureRoom(triageDeptId, "DEMO Triage Room 1", "room:triage-1");
      await ensureRoom(opdDeptId, "DEMO Consult Room 1", "room:consult-1");

      const storeRows = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.facilityId, facilityId), eq(stores.branchId, branchId), eq(stores.kind, "pharmacy")))
        .limit(1);
      pharmacyStoreId = storeRows[0]?.id ?? id("store:pharmacy");
      if (!storeRows[0]) {
        await tx.insert(stores).values({
          id: pharmacyStoreId,
          facilityId,
          branchId,
          name: "DEMO Pharmacy Store",
          kind: "pharmacy",
          active: true,
          createdBy: ACTORS.admin.userId,
          updatedAt: new Date(),
        });
        bump("stores");
      }
      void pharmacyDeptId;

      const staffDefs = [
        { ...ACTORS.admin, name: "DEMO Admin", email: "demo-admin@regdemo.local", staffNumber: "DEMO-STF-001", role: "admin" as const },
        { ...ACTORS.receptionist, name: "DEMO Reception", email: "demo-reception@regdemo.local", staffNumber: "DEMO-STF-002", role: "receptionist" as const },
        { ...ACTORS.nurse, name: "DEMO Nurse", email: "demo-nurse@regdemo.local", staffNumber: "DEMO-STF-003", role: "triage_nurse" as const },
        { ...ACTORS.doctor, name: "DEMO Doctor", email: "demo-doctor@regdemo.local", staffNumber: "DEMO-STF-004", role: "doctor" as const },
        { ...ACTORS.lab, name: "DEMO Lab Tech", email: "demo-lab@regdemo.local", staffNumber: "DEMO-STF-005", role: "lab_tech" as const },
        { ...ACTORS.pharmacist, name: "DEMO Pharmacist", email: "demo-pharmacy@regdemo.local", staffNumber: "DEMO-STF-006", role: "pharmacist" as const },
        { ...ACTORS.cashier, name: "DEMO Cashier", email: "demo-cashier@regdemo.local", staffNumber: "DEMO-STF-007", role: "cashier" as const },
        { ...ACTORS.shaSubmitter, name: "DEMO SHA Submitter", email: "demo-sha-submit@regdemo.local", staffNumber: "DEMO-STF-008", role: "revenue_cycle_officer" as const },
        { ...ACTORS.shaAdjudicator, name: "DEMO SHA Adjudicator", email: "demo-sha-adjudicate@regdemo.local", staffNumber: "DEMO-STF-009", role: "revenue_cycle_officer" as const },
        { ...ACTORS.shaRemitter, name: "DEMO SHA Remitter", email: "demo-sha-remit@regdemo.local", staffNumber: "DEMO-STF-010", role: "finance_officer" as const },
      ];

      for (const staff of staffDefs) {
        const result = await ensureStaff(tx as unknown as Db, facilityId, staff);
        if (result.created.user) bump("users");
        if (result.created.profile) bump("staffProfiles");
        if (result.created.role) bump("staffRoleScopes");
      }

      for (const staff of staffDefs.filter((s) => s.role === "admin")) {
        for (const section of ADMIN_SECTIONS) {
          const existing = await tx
            .select({ id: adminSectionPermissions.id })
            .from(adminSectionPermissions)
            .where(
              and(
                eq(adminSectionPermissions.userId, staff.userId),
                eq(adminSectionPermissions.facilityId, facilityId),
                eq(adminSectionPermissions.section, section),
              ),
            )
            .limit(1);
          if (!existing[0]) {
            await tx.insert(adminSectionPermissions).values({
              id: id(`admin-section:${staff.userId}:${section}`),
              userId: staff.userId,
              facilityId,
              section,
              createdAt: new Date(),
            });
            bump("adminSectionPermissions");
          }
        }
      }

      await seedRegulatoryDefaults(tx as unknown as Parameters<typeof seedRegulatoryDefaults>[0], facilityId, {
        createdBy: ACTORS.admin.userId,
      });
    });

    const cmdOpts = { database: db, mode: "clinic" as const };

    // Regulatory profile / placeholders (demo values only, no guessed real regulator values)
    const profileRows = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.id, facilityId))
      .limit(1);
    void profileRows;

    const existingRegProfile = await db.execute(sql`
      SELECT kmpdc_number AS "kmpdcNumber"
      FROM facility_regulatory_profiles
      WHERE facility_id = ${facilityId}::uuid
      LIMIT 1
    `);
    const regProfile = ((existingRegProfile as unknown as { rows?: Array<{ kmpdcNumber?: string | null }> }).rows ?? [])[0];
    if (!regProfile?.kmpdcNumber) {
      await loadRegulatoryTestPlaceholders(
        {
          facilityId,
          idempotencyKey: key("regulatory:load-placeholders"),
          actor: ACTORS.admin,
        },
        cmdOpts,
      );
      bump("regulatoryPlaceholders");
    } else {
      skip("regulatory.loadRegulatoryTestPlaceholders", "Regulatory profile already present; skipped to keep seeder idempotent.");
    }

    await upsertFacilityRegulatoryProfile(
      {
        facilityId,
        idempotencyKey: key("regulatory:profile-demo-note"),
        actor: ACTORS.admin,
        kmpdcNumber: "TEST-KMPDC-0001",
        kmhflId: "TEST-KMHFL-0001",
        kephLevel: 2,
        facilityCategory: "medical_clinic",
        ownership: "private",
        county: "DEMO COUNTY",
        subCounty: "DEMO SUB-COUNTY",
        constituency: "DEMO CONSTITUENCY",
        ward: "DEMO WARD",
        licenceNo: "TEST-LIC-0001",
        licenceIssueDate: "2026-01-01",
        licenceExpiryDate: "2027-12-31",
        licenceStatus: "active",
        indemnityProvider: "DEMO PLACEHOLDER INSURER",
        indemnityNo: "DEMO-INDEMNITY-0001",
        indemnityExpiryDate: "2028-01-01",
        shaFacilityCode: "TEST-SHA-0001",
        shaEmpanelmentStatus: "active",
        odpcRegistrationNo: "TEST-ODPC-0001",
        odpcCategory: "DEMO PLACEHOLDER DATA CONTROLLER",
        odpcExpiryDate: "2028-01-01",
        kraPin: "P000000000T",
        tccNo: "TEST-TCC-0001",
        tccExpiryDate: "2027-12-31",
        nssfEmployerCode: "TEST-NSSF-0001",
        shifEmployerCode: "TEST-SHIF-0001",
        kemsaSupplierCode: "TEST-KEMSA-0001",
      },
      cmdOpts,
    );

    // Ensure an accepted SHA adjudication code for demo accepted claims.
    await upsertShaAdjudicationCode(
      {
        facilityId,
        idempotencyKey: key("regulatory:sha-code-accepted"),
        actor: ACTORS.admin,
        code: "DEMO-SHA-ACC-01",
        description: "DEMO accepted adjudication code - local seed only",
        category: "approved",
        retryable: false,
        actionHint: "DEMO: accepted for local workflow seeding.",
        active: true,
      },
      cmdOpts,
    );

    // Catalog: service, lab test, drug item, prices
    const consultationCode = "DEMO-SVC-CONSULT";
    const labCode = "DEMO-LAB-MALARIA";
    const drugCode = "DEMO-DRUG-PARA500";

    const existingConsult = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.code, consultationCode), eq(services.facilityId, facilityId)))
      .limit(1);
    let consultationServiceId = existingConsult[0]?.id;
    if (!consultationServiceId) {
      consultationServiceId = id("service:consult");
      await db.insert(services).values({
        id: consultationServiceId,
        facilityId,
        code: consultationCode,
        name: `${DEMO_MARKER} General Consultation`,
        kind: "consultation",
        defaultPrice: "800.00",
        active: true,
        createdBy: ACTORS.admin.userId,
        updatedAt: new Date(),
      });
      bump("services");
    }

    const existingLab = await db
      .select({ id: labTests.id })
      .from(labTests)
      .where(and(eq(labTests.code, labCode), eq(labTests.facilityId, facilityId)))
      .limit(1);
    let labTestId = existingLab[0]?.id;
    if (!labTestId) {
      labTestId = id("labtest:malaria");
      await db.insert(labTests).values({
        id: labTestId,
        facilityId,
        code: labCode,
        name: `${DEMO_MARKER} Malaria Rapid Test`,
        sampleType: "Blood",
        parameters: [
          { name: "Parasite", unit: "result", refLow: null, refHigh: null, criticalLow: null, criticalHigh: null },
        ],
        active: true,
        createdBy: ACTORS.admin.userId,
        updatedAt: new Date(),
      });
      bump("labTests");
    }

    const existingDrug = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.code, drugCode), eq(items.facilityId, facilityId)))
      .limit(1);
    let drugItemId = existingDrug[0]?.id;
    if (!drugItemId) {
      drugItemId = id("item:paracetamol");
      await db.insert(items).values({
        id: drugItemId,
        facilityId,
        code: drugCode,
        name: `${DEMO_MARKER} Paracetamol 500mg Tablets`,
        kind: "drug",
        unit: "tablet",
        strength: "500mg",
        form: "tablet",
        active: true,
        createdBy: ACTORS.admin.userId,
        updatedAt: new Date(),
      });
      bump("items");
    }

    // Price list + prices via commands
    const cashPriceListRows = await db
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(and(eq(priceLists.facilityId, facilityId), eq(priceLists.payerType, "cash")))
      .limit(1);
    let cashPriceListId = cashPriceListRows[0]?.id;
    if (!cashPriceListId) {
      cashPriceListId = id("pricelist:cash");
      await db.insert(priceLists).values({
        id: cashPriceListId,
        facilityId,
        name: `${DEMO_MARKER} Cash Price List`,
        payerType: "cash",
        active: true,
        createdBy: ACTORS.admin.userId,
        updatedAt: new Date(),
      });
      bump("priceLists");
    }

    const labServiceCode = labCode;
    const existingLabService = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.code, labServiceCode), eq(services.facilityId, facilityId)))
      .limit(1);
    let labServiceId = existingLabService[0]?.id;
    if (!labServiceId) {
      labServiceId = id("service:lab-malaria");
      await db.insert(services).values({
        id: labServiceId,
        facilityId,
        code: labServiceCode,
        name: `${DEMO_MARKER} Malaria Rapid Test Service`,
        kind: "lab",
        defaultPrice: "500.00",
        active: true,
        createdBy: ACTORS.admin.userId,
        updatedAt: new Date(),
      });
      bump("services");
    }

    await upsertPrice(
      {
        facilityId,
        idempotencyKey: key("price:consult"),
        actor: ACTORS.admin,
        priceListId: cashPriceListId,
        targetType: "service",
        targetId: consultationServiceId,
        amount: "800.00",
      },
      cmdOpts,
    );
    await upsertPrice(
      {
        facilityId,
        idempotencyKey: key("price:lab-service"),
        actor: ACTORS.admin,
        priceListId: cashPriceListId,
        targetType: "service",
        targetId: labServiceId,
        amount: "500.00",
      },
      cmdOpts,
    );
    await upsertPrice(
      {
        facilityId,
        idempotencyKey: key("price:drug-paracetamol"),
        actor: ACTORS.admin,
        priceListId: cashPriceListId,
        targetType: "item",
        targetId: drugItemId,
        amount: "20.00",
      },
      cmdOpts,
    );

    // Minimal ledger mappings for billing/SHA posting (local demo setup).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
      const defaults: Array<{ code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; systemRole: string; normalBalance: "debit" | "credit" }> = [
        { code: "DEMO-1000", name: "DEMO Cash", type: "asset", systemRole: "cash", normalBalance: "debit" },
        { code: "DEMO-1010", name: "DEMO Bank", type: "asset", systemRole: "bank", normalBalance: "debit" },
        { code: "DEMO-1100", name: "DEMO Patient Receivable", type: "asset", systemRole: "patient_receivable", normalBalance: "debit" },
        { code: "DEMO-1110", name: "DEMO Insurance Receivable", type: "asset", systemRole: "insurance_receivable", normalBalance: "debit" },
        { code: "DEMO-4000", name: "DEMO Service Revenue", type: "revenue", systemRole: "service_revenue", normalBalance: "credit" },
      ];
      for (const acct of defaults) {
        const existing = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.facilityId, facilityId), eq(ledgerAccounts.systemRole, acct.systemRole)))
          .limit(1);
        if (existing[0]) continue;
        await tx.insert(ledgerAccounts).values({
          id: id(`ledger:${acct.systemRole}`),
          facilityId,
          code: acct.code,
          name: `${DEMO_MARKER} ${acct.name}`,
          type: acct.type,
          normalBalance: acct.normalBalance,
          systemRole: acct.systemRole,
          active: true,
          createdBy: ACTORS.admin.userId,
          updatedAt: new Date(),
        });
        bump("ledgerAccounts");
      }
    });

    // Receive stock for dispensing
    const batchNo = "DEMO-BATCH-001";
    const existingBatch = await db.execute(sql`
      SELECT id FROM item_batches
      WHERE facility_id = ${facilityId}::uuid AND item_id = ${drugItemId}::uuid AND batch_no = ${batchNo}
      LIMIT 1
    `);
    const hasBatch = (((existingBatch as unknown as { rows?: unknown[] }).rows ?? []).length > 0);
    if (!hasBatch) {
      await receiveStock(
        {
          facilityId,
          idempotencyKey: key("stock:receive:paracetamol"),
          actor: ACTORS.pharmacist,
          storeId: pharmacyStoreId,
          itemId: drugItemId,
          batchNo,
          expiryDate: "2028-12-31",
          unitCost: 5,
          quantity: 200,
          note: "DEMO seed stock",
        },
        cmdOpts,
      );
      bump("stockReceipts");
    } else {
      skip("stock.receive", "DEMO batch already exists; skipped to avoid duplicate stock ledger entries.");
    }

    // Patient + clinical workflow
    const patientNationalId = "DEMO-NID-0001";
    let patientId = (
      await db
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.facilityId, facilityId), eq(patients.nationalId, patientNationalId)))
        .limit(1)
    )[0]?.id;
    if (!patientId) {
      const reg = await registerPatient(
        {
          facilityId,
          idempotencyKey: key("patient:register:adult"),
          actor: ACTORS.receptionist,
          firstName: "DEMO",
          lastName: "Patient One",
          dob: "1990-01-15",
          sex: "female",
          nationalId: patientNationalId,
          phone: "+254700000001",
          payerType: "cash",
          allergies: ["DEMO: None reported"],
        },
        cmdOpts,
      );
      patientId = reg.patientId;
      bump("patients");
    }

    const visitKey = key("encounter:start:patient1");
    let encounterId = (await getCommandResult<{ encounterId: string }>(db, facilityId, visitKey))?.encounterId;
    if (!encounterId) {
      const visit = await startVisit(
        {
          facilityId,
          idempotencyKey: visitKey,
          actor: ACTORS.receptionist,
          patientId,
          branchId,
          payerType: "cash",
        },
        cmdOpts,
      );
      encounterId = visit.encounterId;
      bump("encounters");
    }

    const triageQueueKey = key("queue:triage:patient1");
    let triageQueueId = (await getCommandResult<{ queueEntryId: string }>(db, facilityId, triageQueueKey))?.queueEntryId;
    if (!triageQueueId) {
      const q = await queuePatient(
        {
          facilityId,
          idempotencyKey: triageQueueKey,
          actor: ACTORS.receptionist,
          encounterId,
          department: "Triage",
          roomId: triageRoomId,
          priority: "normal",
        },
        cmdOpts,
      );
      triageQueueId = q.queueEntryId;
      bump("queueEntries");
    }

    const triageKey = key("triage:record:patient1");
    const triageDone = await getCommandResult(db, facilityId, triageKey);
    if (!triageDone) {
      await recordTriageVitals(
        {
          facilityId,
          idempotencyKey: triageKey,
          actor: ACTORS.nurse,
          encounterId,
          queueEntryId: triageQueueId,
          roomId: triageRoomId,
          systolic: 120,
          diastolic: 80,
          heartRate: 72,
          respRate: 16,
          temperature: 37.0,
          spo2: 98,
          weightKg: 65,
          heightCm: 165,
          painScore: 2,
          category: "green",
          chiefComplaint: "DEMO: Fever and headache for two days",
        },
        cmdOpts,
      );
      bump("triageVitals");
    }

    const consultStartKey = key("consult:start:patient1");
    let doctorQueueId = (await getCommandResult<{ queueEntryId: string }>(db, facilityId, consultStartKey))?.queueEntryId;
    if (!doctorQueueId) {
      const started = await startConsultation(
        {
          facilityId,
          idempotencyKey: consultStartKey,
          actor: ACTORS.doctor,
          encounterId,
        },
        cmdOpts,
      );
      doctorQueueId = started.queueEntryId;
      bump("consultations");
    }
    void doctorQueueId;

    const noteKey = key("consult:note:patient1");
    if (!(await getCommandResult(db, facilityId, noteKey))) {
      await saveClinicalNote(
        {
          facilityId,
          idempotencyKey: noteKey,
          actor: ACTORS.doctor,
          encounterId,
          subjective: "DEMO: Patient reports fever and headache.",
          objective: "DEMO: Vitals stable, mild pallor.",
          assessment: "DEMO: Suspected uncomplicated malaria.",
          plan: "DEMO: Perform malaria test, give paracetamol, review results.",
          sign: true,
        },
        cmdOpts,
      );
      bump("clinicalNotes");
    }

    // Diagnosis (B54 exists in ICD10 csv; verify present)
    const icd = await db.execute(sql`SELECT code FROM icd10_codes WHERE code = 'B54' LIMIT 1`);
    const hasIcd = (((icd as unknown as { rows?: unknown[] }).rows ?? []).length > 0);
    if (hasIcd) {
      const dxKey = key("diagnosis:b54:patient1");
      if (!(await getCommandResult(db, facilityId, dxKey))) {
        try {
          await recordDiagnosis(
            {
              facilityId,
              idempotencyKey: dxKey,
              actor: ACTORS.doctor,
              encounterId,
              icd10Code: "B54",
              isPrimary: true,
            },
            cmdOpts,
          );
          bump("diagnoses");
        } catch (e) {
          skip("diagnosis.record", e instanceof Error ? e.message : String(e));
        }
      }
    } else {
      skip("diagnosis.record", "ICD-10 code B54 not found in icd10_codes; skipped diagnosis to avoid unsafe raw insert.");
    }

    const labOrderKey = key("lab:order:patient1");
    let labOrderId = (await getCommandResult<{ labOrderId: string }>(db, facilityId, labOrderKey))?.labOrderId;
    if (!labOrderId) {
      const ordered = await orderLabTests(
        {
          facilityId,
          idempotencyKey: labOrderKey,
          actor: ACTORS.doctor,
          encounterId,
          labTestIds: [labTestId],
          clinicalNotes: "DEMO: Rule out malaria",
        },
        cmdOpts,
      );
      labOrderId = ordered.labOrderId;
      bump("labOrders");
    }

    const collectKey = key("lab:collect:patient1");
    if (!(await getCommandResult(db, facilityId, collectKey))) {
      await collectLabSample({ facilityId, idempotencyKey: collectKey, actor: ACTORS.lab, labOrderId }, cmdOpts);
      bump("labSamplesCollected");
    }
    const processKey = key("lab:process:patient1");
    if (!(await getCommandResult(db, facilityId, processKey))) {
      await startLabProcessing({ facilityId, idempotencyKey: processKey, actor: ACTORS.lab, labOrderId }, cmdOpts);
      bump("labProcessingStarted");
    }

    const labItemRows = await db.execute(sql`
      SELECT id FROM lab_order_items WHERE facility_id = ${facilityId}::uuid AND lab_order_id = ${labOrderId}::uuid ORDER BY created_at ASC LIMIT 1
    `);
    const labOrderItemId = ((labItemRows as unknown as { rows?: Array<{ id: string }> }).rows ?? [])[0]?.id;
    if (labOrderItemId) {
      const enterKey = key("lab:enter:patient1");
      if (!(await getCommandResult(db, facilityId, enterKey))) {
        await enterLabResults(
          {
            facilityId,
            idempotencyKey: enterKey,
            actor: ACTORS.lab,
            labOrderId,
            results: [{ labOrderItemId, parameter: "Parasite", value: "Negative" }],
          },
          cmdOpts,
        );
        bump("labResultsEntered");
      }
      const verifyKey = key("lab:verify:patient1");
      if (!(await getCommandResult(db, facilityId, verifyKey))) {
        await verifyLabResults({ facilityId, idempotencyKey: verifyKey, actor: ACTORS.lab, labOrderId }, cmdOpts);
        bump("labResultsVerified");
      }
    } else {
      skip("lab.results", "Lab order item not found; skipped result entry/verification.");
    }

    const rxKey = key("prescription:patient1");
    let prescriptionId = (await getCommandResult<{ prescriptionId: string }>(db, facilityId, rxKey))?.prescriptionId;
    if (!prescriptionId) {
      const rx = await prescribe(
        {
          facilityId,
          idempotencyKey: rxKey,
          actor: ACTORS.doctor,
          encounterId,
          itemId: drugItemId,
          dose: "500 mg",
          route: "oral",
          frequency: "three times daily",
          durationDays: 3,
          quantity: 9,
          instructions: "DEMO: Take after meals",
        },
        cmdOpts,
      );
      prescriptionId = rx.prescriptionId;
      bump("prescriptions");
    }

    const dispenseKey = key("dispense:patient1");
    if (!(await getCommandResult(db, facilityId, dispenseKey))) {
      try {
        await dispensePrescription(
          {
            facilityId,
            idempotencyKey: dispenseKey,
            actor: ACTORS.pharmacist,
            prescriptionId,
            storeId: pharmacyStoreId,
            quantity: 9,
            note: "DEMO dispense",
          },
          cmdOpts,
        );
        bump("dispenses");
      } catch (e) {
        skip("pharmacy.dispense", e instanceof Error ? e.message : String(e));
      }
    }

    // Billing: cashier session, invoice, payment
    const sessionKey = key("cashier:open:patient1");
    const session = await getCommandResult<{ sessionId: string; alreadyOpen: boolean }>(db, facilityId, sessionKey);
    if (!session) {
      await openCashierSession(
        {
          facilityId,
          idempotencyKey: sessionKey,
          actor: ACTORS.cashier,
          openingFloat: 1000,
          branchId,
        },
        cmdOpts,
      );
      bump("cashierSessions");
    }

    const invoiceKey = key("invoice:open:patient1");
    let invoiceId = (await getCommandResult<{ invoiceId: string; total: string; paid: string }>(db, facilityId, invoiceKey))?.invoiceId;
    if (!invoiceId) {
      try {
        const inv = await openInvoice(
          {
            facilityId,
            idempotencyKey: invoiceKey,
            actor: ACTORS.cashier,
            encounterId,
            notes: "DEMO invoice for seeded clinical visit",
          },
          cmdOpts,
        );
        invoiceId = inv.invoiceId;
        bump("invoices");
      } catch (e) {
        skip("billing.openInvoice", e instanceof Error ? e.message : String(e));
      }
    }

    if (invoiceId) {
      const payKey = key("payment:take:patient1");
      if (!(await getCommandResult(db, facilityId, payKey))) {
        const invRows = await db
          .select({ total: invoices.total, paid: invoices.paid, status: invoices.status })
          .from(invoices)
          .where(and(eq(invoices.id, invoiceId), eq(invoices.facilityId, facilityId)))
          .limit(1);
        const inv = invRows[0];
        const outstanding = inv ? Math.max(0, Number(inv.total) - Number(inv.paid)) : 0;
        if (inv && outstanding > 0 && inv.status !== "void") {
          try {
            await takePayment(
              {
                facilityId,
                idempotencyKey: payKey,
                actor: ACTORS.cashier,
                invoiceId,
                tenders: [{ method: "cash", amount: outstanding, reference: "DEMO-CASH-001" }],
                note: "DEMO cash payment",
              },
              cmdOpts,
            );
            bump("payments");
          } catch (e) {
            skip("billing.takePayment", e instanceof Error ? e.message : String(e));
          }
        } else {
          skip("billing.takePayment", "Invoice has no outstanding balance or is void.");
        }
      }
    } else {
      skip("billing.takePayment", "Invoice was not created; payment skipped.");
    }

    // Payer/contract/benefit (revenue)
    const payerCode = "DEMO-PAYER-001";
    let payerId = (
      await db.select({ id: sql<string>`id` }).from(sql`payers`).where(sql`facility_id = ${facilityId}::uuid AND code = ${payerCode}`).limit(1) as unknown as Array<{ id: string }>
    )[0]?.id;
    if (!payerId) {
      try {
        const payer = await createPayer(
          {
            facilityId,
            idempotencyKey: key("payer:create"),
            actor: ACTORS.admin,
            code: payerCode,
            name: `${DEMO_MARKER} Insurance Payer`,
            kind: "insurer",
            contactName: "DEMO Contact",
            phone: "+254700000099",
            email: "demo-payer@example.invalid",
          },
          cmdOpts,
        );
        payerId = payer.payerId;
        bump("payers");
      } catch (e) {
        skip("revenue.createPayer", e instanceof Error ? e.message : String(e));
      }
    }

    let contractId: string | undefined;
    if (payerId) {
      const contractNo = "DEMO-CONTRACT-001";
      const existingContract = await db.execute(sql`
        SELECT id FROM payer_contracts WHERE facility_id = ${facilityId}::uuid AND contract_no = ${contractNo} LIMIT 1
      `);
      contractId = ((existingContract as unknown as { rows?: Array<{ id: string }> }).rows ?? [])[0]?.id;
      if (!contractId) {
        try {
          const contract = await createPayerContract(
            {
              facilityId,
              idempotencyKey: key("payer:contract"),
              actor: ACTORS.admin,
              payerId,
              contractNo,
              startDate: "2026-01-01",
              endDate: "2027-12-31",
              notes: "DEMO payer contract",
            },
            cmdOpts,
          );
          contractId = contract.contractId;
          bump("payerContracts");
        } catch (e) {
          skip("revenue.createPayerContract", e instanceof Error ? e.message : String(e));
        }
      }

      if (contractId) {
        const benefitKey = key("payer:benefit");
        if (!(await getCommandResult(db, facilityId, benefitKey))) {
          try {
            await createPayerBenefit(
              {
                facilityId,
                idempotencyKey: benefitKey,
                actor: ACTORS.admin,
                contractId,
                category: "DEMO outpatient",
                annualLimit: "50000.00",
                perVisitLimit: "5000.00",
                copayPercent: "0",
              },
              cmdOpts,
            );
            bump("payerBenefits");
          } catch (e) {
            skip("revenue.createPayerBenefit", e instanceof Error ? e.message : String(e));
          }
        }
      }
    }

    // SHA workflow: separate patient/visit/invoice for SHA claim lifecycle
    const shaPatientNationalId = "DEMO-NID-SHA-001";
    let shaPatientId = (
      await db
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.facilityId, facilityId), eq(patients.nationalId, shaPatientNationalId)))
        .limit(1)
    )[0]?.id;
    if (!shaPatientId) {
      try {
        const reg = await registerPatient(
          {
            facilityId,
            idempotencyKey: key("patient:register:sha"),
            actor: ACTORS.receptionist,
            firstName: "DEMO",
            lastName: "SHA Patient",
            dob: "1985-06-20",
            sex: "male",
            nationalId: shaPatientNationalId,
            phone: "+254700000002",
            payerType: "sha",
            payerMemberNo: "DEMO-SHA-MEMBER-001",
          },
          cmdOpts,
        );
        shaPatientId = reg.patientId;
        bump("patients");
      } catch (e) {
        skip("sha.patient", e instanceof Error ? e.message : String(e));
      }
    }

    // SHA payer/empanelment/benefit package
    const shaPayerCode = "DEMO-SHA-PAYER";
    let shaPayerId = (
      await db
        .select({ id: sql<string>`id` })
        .from(sql`payers`)
        .where(sql`facility_id = ${facilityId}::uuid AND code = ${shaPayerCode}`)
        .limit(1) as unknown as Array<{ id: string }>
    )[0]?.id;
    if (!shaPayerId) {
      try {
        const payer = await createPayer(
          {
            facilityId,
            idempotencyKey: key("payer:create:sha"),
            actor: ACTORS.admin,
            code: shaPayerCode,
            name: `${DEMO_MARKER} SHA Payer`,
            kind: "sha",
            contactName: "DEMO SHA Contact",
            email: "demo-sha-payer@example.invalid",
          },
          cmdOpts,
        );
        shaPayerId = payer.payerId;
        bump("payers");
      } catch (e) {
        skip("sha.createPayer", e instanceof Error ? e.message : String(e));
      }
    }

    let shaEmpanelmentId: string | undefined;
    if (shaPayerId) {
      const existingEmp = await db.execute(sql`
        SELECT id FROM sha_empanelments
        WHERE facility_id = ${facilityId}::uuid AND fund = 'shif' AND scheme_code = 'DEMO-SHIF-001'
        LIMIT 1
      `);
      shaEmpanelmentId = ((existingEmp as unknown as { rows?: Array<{ id: string }> }).rows ?? [])[0]?.id;
      if (!shaEmpanelmentId) {
        try {
          const emp = await createEmpanelment(
            {
              facilityId,
              idempotencyKey: key("sha:empanelment"),
              actor: ACTORS.admin,
              kmpdcNumber: "TEST-KMPDC-0001",
              fund: "shif",
              schemeCode: "DEMO-SHIF-001",
              schemeName: `${DEMO_MARKER} SHIF Outpatient Demo Scheme`,
              contractNo: "DEMO-SHIF-CONTRACT-001",
              effectiveFrom: "2026-01-01",
              expiryDate: "2027-12-31",
              tariffVersion: "DEMO-TARIFF-001",
            },
            cmdOpts,
          );
          shaEmpanelmentId = emp.empanelmentId;
          bump("shaEmpanelments");
        } catch (e) {
          skip("sha.createEmpanelment", e instanceof Error ? e.message : String(e));
        }
      }
    }

    let shaBenefitPackageId: string | undefined;
    if (shaEmpanelmentId) {
      const existingPkg = await db.execute(sql`
        SELECT id FROM benefit_packages
        WHERE facility_id = ${facilityId}::uuid AND fund = 'shif' AND package_code = 'DEMO-SHIF-OPD'
        LIMIT 1
      `);
      shaBenefitPackageId = ((existingPkg as unknown as { rows?: Array<{ id: string }> }).rows ?? [])[0]?.id;
      if (!shaBenefitPackageId) {
        try {
          const pkg = await createBenefitPackage(
            {
              facilityId,
              idempotencyKey: key("sha:benefit-package"),
              actor: ACTORS.admin,
              fund: "shif",
              packageCode: "DEMO-SHIF-OPD",
              name: `${DEMO_MARKER} SHIF Outpatient Package`,
              careLevel: "level-2",
              careType: "outpatient",
              effectiveFrom: "2026-01-01",
              effectiveTo: "2027-12-31",
              items: [
                {
                  serviceId: consultationServiceId,
                  shaServiceCode: "DEMO-SHA-SVC-CONSULT",
                  category: "consultation",
                  description: `${DEMO_MARKER} General consultation`,
                  coverage: "full",
                  requiresPreauth: false,
                  coPayPercent: 0,
                  unitPrice: "800.00",
                },
              ],
            },
            cmdOpts,
          );
          shaBenefitPackageId = pkg.benefitPackageId;
          bump("shaBenefitPackages");
        } catch (e) {
          skip("sha.createBenefitPackage", e instanceof Error ? e.message : String(e));
        }
      }
    }

    // Payer sharing consent for SHA patient (required by createShaClaim).
    if (shaPatientId) {
      const consentKey = key("privacy:consent:sha-payer-sharing");
      if (!(await getCommandResult(db, facilityId, consentKey))) {
        try {
          await recordConsent(
            {
              facilityId,
              idempotencyKey: consentKey,
              actor: ACTORS.receptionist,
              patientId: shaPatientId,
              consentType: "payer_sharing",
              consentVersion: "DEMO-v1",
              consentTextHash: null,
              granted: true,
              grantedAt: new Date().toISOString(),
              grantedBy: "DEMO patient",
              source: "seed-demo-data",
              documentId: null,
              validFrom: new Date().toISOString(),
              validTo: null,
            },
            cmdOpts,
          );
          bump("dataConsents");
        } catch (e) {
          skip("sha.payerSharingConsent", e instanceof Error ? e.message : String(e));
        }
      }
    }

    // SHA encounter/invoice for claim lifecycle
    let shaEncounterId: string | undefined;
    let shaInvoiceId: string | undefined;
    let shaClaimId: string | undefined;
    let shaClaimLines: Array<{ id: string; amount: string }> = [];
    // shaClaimNo intentionally not tracked; claim is referenced by id/ref.
    let shaClaimRef: string | undefined;

    if (shaPatientId) {
      const shaVisitKey = key("encounter:start:sha");
      shaEncounterId = (await getCommandResult<{ encounterId: string }>(db, facilityId, shaVisitKey))?.encounterId;
      if (!shaEncounterId) {
        try {
          const visit = await startVisit(
            {
              facilityId,
              idempotencyKey: shaVisitKey,
              actor: ACTORS.receptionist,
              patientId: shaPatientId,
              branchId,
              payerType: "sha",
            },
            cmdOpts,
          );
          shaEncounterId = visit.encounterId;
          bump("encounters");
        } catch (e) {
          skip("sha.encounter", e instanceof Error ? e.message : String(e));
        }
      }

      if (shaEncounterId) {
        // Minimal clinical activity to generate billable charge lines.
        const shaConsultKey = key("consult:start:sha");
        if (!(await getCommandResult(db, facilityId, shaConsultKey))) {
          try {
            await startConsultation({ facilityId, idempotencyKey: shaConsultKey, actor: ACTORS.doctor, encounterId: shaEncounterId }, cmdOpts);
            bump("consultations");
          } catch (e) {
            skip("sha.consult", e instanceof Error ? e.message : String(e));
          }
        }
        const shaNoteKey = key("consult:note:sha");
        if (!(await getCommandResult(db, facilityId, shaNoteKey))) {
          try {
            await saveClinicalNote(
              {
                facilityId,
                idempotencyKey: shaNoteKey,
                actor: ACTORS.doctor,
                encounterId: shaEncounterId,
                subjective: "DEMO: SHA patient follow-up.",
                objective: "DEMO: Stable.",
                assessment: "DEMO: General outpatient visit.",
                plan: "DEMO: Consultation and medication.",
                sign: true,
              },
              cmdOpts,
            );
            bump("clinicalNotes");
          } catch (e) {
            skip("sha.clinicalNote", e instanceof Error ? e.message : String(e));
          }
        }
        const shaRxKey = key("prescription:sha");
        let shaPrescriptionId = (await getCommandResult<{ prescriptionId: string }>(db, facilityId, shaRxKey))?.prescriptionId;
        if (!shaPrescriptionId) {
          try {
            const rx = await prescribe(
              {
                facilityId,
                idempotencyKey: shaRxKey,
                actor: ACTORS.doctor,
                encounterId: shaEncounterId,
                itemId: drugItemId,
                dose: "500 mg",
                route: "oral",
                frequency: "twice daily",
                durationDays: 2,
                quantity: 4,
                instructions: "DEMO: SHA prescription",
              },
              cmdOpts,
            );
            shaPrescriptionId = rx.prescriptionId;
            bump("prescriptions");
          } catch (e) {
            skip("sha.prescribe", e instanceof Error ? e.message : String(e));
          }
        }
        if (shaPrescriptionId) {
          const shaDispenseKey = key("dispense:sha");
          if (!(await getCommandResult(db, facilityId, shaDispenseKey))) {
            try {
              await dispensePrescription(
                {
                  facilityId,
                  idempotencyKey: shaDispenseKey,
                  actor: ACTORS.pharmacist,
                  prescriptionId: shaPrescriptionId,
                  storeId: pharmacyStoreId,
                  quantity: 4,
                  note: "DEMO SHA dispense",
                },
                cmdOpts,
              );
              bump("dispenses");
            } catch (e) {
              skip("sha.dispense", e instanceof Error ? e.message : String(e));
            }
          }
        }

        const shaInvoiceKey = key("invoice:open:sha");
        shaInvoiceId = (await getCommandResult<{ invoiceId: string }>(db, facilityId, shaInvoiceKey))?.invoiceId;
        if (!shaInvoiceId) {
          try {
            const inv = await openInvoice(
              {
                facilityId,
                idempotencyKey: shaInvoiceKey,
                actor: ACTORS.cashier,
                encounterId: shaEncounterId,
                notes: "DEMO SHA claimable invoice",
              },
              cmdOpts,
            );
            shaInvoiceId = inv.invoiceId;
            bump("invoices");
          } catch (e) {
            skip("sha.openInvoice", e instanceof Error ? e.message : String(e));
          }
        }
      }
    }

    // Controlled local demo setup: mark SHA invoice claimable and ensure it has a claimable line.
    // No command exists for isShaClaimable; this is a local-only demo exception, documented in output.
    if (shaInvoiceId) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
          await tx.execute(sql`
            UPDATE invoices
            SET is_sha_claimable = true, updated_at = now(), version = version + 1
            WHERE id = ${shaInvoiceId}::uuid AND facility_id = ${facilityId}::uuid
          `);
          const chargeRows = await tx.execute(sql`
            SELECT id, amount::text AS amount
            FROM charges
            WHERE invoice_id = ${shaInvoiceId}::uuid AND facility_id = ${facilityId}::uuid AND voided_at IS NULL
            ORDER BY created_at ASC
          `);
          const chargeLines = ((chargeRows as unknown as { rows?: Array<{ id: string; amount: string }> }).rows ?? []);
          if (chargeLines.length === 0) {
            const chargeId = id("charge:sha-demo-consult");
            await tx.execute(sql`
              INSERT INTO charges (
                id, facility_id, encounter_id, invoice_id, source_type, source_id,
                service_id, item_id, description, quantity, unit_price, amount,
                voided_at, voided_by, created_by, created_at, updated_at, version
              ) VALUES (
                ${chargeId}::uuid, ${facilityId}::uuid, ${shaEncounterId}::uuid, ${shaInvoiceId}::uuid,
                'demo_seed', ${`demo:${FACILITY_CODE}:sha-consult-charge`},
                ${consultationServiceId}::uuid, NULL, ${`${DEMO_MARKER} SHA Consultation`},
                1, 800.00, 800.00,
                NULL, NULL, ${ACTORS.admin.userId}, now(), now(), 1
              )
              ON CONFLICT (facility_id, source_type, source_id) WHERE voided_at IS NULL DO NOTHING
            `);
            await tx.execute(sql`
              UPDATE invoices
              SET subtotal = 800.00, total = 800.00, updated_at = now(), version = version + 1
              WHERE id = ${shaInvoiceId}::uuid AND facility_id = ${facilityId}::uuid
            `);
            skip(
              "sha.invoiceCharge.localSetup",
              "No command exists to add a charge line; inserted a controlled local demo charge with varian.sync_apply=on.",
            );
          }
        });
        skip(
          "sha.invoice.isShaClaimable.localSetup",
          "No command exists to mark invoice SHA-claimable; applied controlled local demo update with varian.sync_apply=on.",
        );
      } catch (e) {
        skip("sha.invoice.localSetup", e instanceof Error ? e.message : String(e));
      }
    }

    // SHA eligibility
    if (shaPatientId && shaPayerId && shaEmpanelmentId) {
      const eligKey = key("sha:eligibility");
      if (!(await getCommandResult(db, facilityId, eligKey))) {
        try {
          await verifyShaEligibility(
            {
              facilityId,
              idempotencyKey: eligKey,
              actor: ACTORS.receptionist,
              patientId: shaPatientId,
              payerId: shaPayerId,
              empanelmentId: shaEmpanelmentId,
              fund: "shif",
              memberRef: "DEMO-SHA-MEMBER-001",
              eligibility: "eligible",
              checkRef: "DEMO-ELIG-001",
              notes: "DEMO eligibility check",
            },
            cmdOpts,
          );
          bump("shaEligibilityChecks");
        } catch (e) {
          skip("sha.verifyEligibility", e instanceof Error ? e.message : String(e));
        }
      }
    }

    // SHA claim lifecycle: create -> submit -> adjudicate -> remittance -> reconcile
    if (shaPatientId && shaEncounterId && shaInvoiceId && shaPayerId && shaEmpanelmentId && shaBenefitPackageId) {
      const claimKey = key("sha:claim:create");
      const existingClaim = await getCommandResult<{ claimId: string }>(db, facilityId, claimKey);
      shaClaimId = existingClaim?.claimId;
      if (!shaClaimId) {
        try {
          const claim = await createShaClaim(
            {
              facilityId,
              idempotencyKey: claimKey,
              actor: ACTORS.doctor, // preparer
              payerId: shaPayerId,
              patientId: shaPatientId,
              encounterId: shaEncounterId,
              invoiceId: shaInvoiceId,
              empanelmentId: shaEmpanelmentId,
              benefitPackageId: shaBenefitPackageId,
              fund: "shif",
              notes: "DEMO SHA claim",
              lines: [
                {
                  serviceId: consultationServiceId,
                  shaServiceCode: "DEMO-SHA-SVC-CONSULT",
                  description: `${DEMO_MARKER} General consultation`,
                  amount: "800.00",
                  unitPrice: "800.00",
                  quantity: 1,
                  patientPay: false,
                },
              ],
            },
            cmdOpts,
          );
          shaClaimId = claim.claimId;
          bump("shaClaims");
        } catch (e) {
          skip("sha.createClaim", e instanceof Error ? e.message : String(e));
        }
      }

      if (shaClaimId) {
        const claimRows = await db.execute(sql`
          SELECT sha_claim_ref AS "shaClaimRef", status
          FROM claims WHERE id = ${shaClaimId}::uuid AND facility_id = ${facilityId}::uuid LIMIT 1
        `);
        const claimRow = ((claimRows as unknown as { rows?: Array<{ shaClaimRef: string | null; status: string }> }).rows ?? [])[0];
        shaClaimRef = claimRow?.shaClaimRef ?? undefined;

        const claimLineRows = await db.execute(sql`
          SELECT id, sha_billed_amount::text AS amount
          FROM claim_lines
          WHERE claim_id = ${shaClaimId}::uuid AND facility_id = ${facilityId}::uuid
          ORDER BY created_at ASC
        `);
        shaClaimLines = ((claimLineRows as unknown as { rows?: Array<{ id: string; amount: string }> }).rows ?? []).map((r) => ({
          id: r.id,
          amount: r.amount ?? "0",
        }));

        const submitKey = key("sha:claim:submit");
        if (!(await getCommandResult(db, facilityId, submitKey))) {
          try {
            const submitted = await submitShaClaim(
              {
                facilityId,
                idempotencyKey: submitKey,
                actor: ACTORS.shaSubmitter, // different from preparer
                claimId: shaClaimId,
                submissionBatch: "DEMO-BATCH-001",
              },
              cmdOpts,
            );
            shaClaimRef = submitted.shaClaimRef;
            bump("shaClaimsSubmitted");
          } catch (e) {
            skip("sha.submitClaim", e instanceof Error ? e.message : String(e));
          }
        } else {
          const submitted = await getCommandResult<{ shaClaimRef?: string }>(db, facilityId, submitKey);
          shaClaimRef = shaClaimRef ?? submitted?.shaClaimRef;
        }

        const adjKey = key("sha:claim:adjudicate");
        if (!(await getCommandResult(db, facilityId, adjKey))) {
          try {
            await recordShaAdjudication(
              {
                facilityId,
                idempotencyKey: adjKey,
                actor: ACTORS.shaAdjudicator, // different from preparer and submitter
                claimId: shaClaimId,
                code: "DEMO-SHA-ACC-01",
                approvedAmount: "800.00",
                note: "DEMO accepted adjudication",
              },
              cmdOpts,
            );
            bump("shaClaimsAdjudicated");
          } catch (e) {
            skip("sha.recordAdjudication", e instanceof Error ? e.message : String(e));
          }
        }

        if (shaClaimLines.length > 0) {
          const remitKey = key("sha:claim:remit");
          if (!(await getCommandResult(db, facilityId, remitKey))) {
            try {
              await recordShaRemittance(
                {
                  facilityId,
                  idempotencyKey: remitKey,
                  actor: ACTORS.shaRemitter, // different from preparer/submitter/approver
                  claimId: shaClaimId,
                  allocations: shaClaimLines.map((line) => ({
                    claimLineId: line.id,
                    amount: line.amount,
                  })),
                  shaPaymentReportRef: "DEMO-SHA-REPORT-001",
                  bankReference: "DEMO-BANK-REF-001",
                  paymentDate: TODAY,
                  reference: "DEMO remittance",
                },
                cmdOpts,
              );
              bump("shaRemittances");
            } catch (e) {
              skip("sha.recordRemittance", e instanceof Error ? e.message : String(e));
            }
          }
        } else {
          skip("sha.recordRemittance", "No claim lines found; remittance skipped.");
        }

        // Reconciliation
        const reportPeriod = TODAY.slice(0, 7);
        const reconcileKey = key("sha:reconcile");
        if (!(await getCommandResult(db, facilityId, reconcileKey))) {
          try {
            const claimRef = shaClaimRef ?? shaClaimId;
            await reconcileShaPaymentReport(
              {
                facilityId,
                idempotencyKey: reconcileKey,
                actor: ACTORS.shaRemitter,
                kmpdcNumber: "TEST-KMPDC-0001",
                reportPeriod,
                reportRef: "DEMO-SHA-REPORT-001",
                shaReportedAmount: "800.00",
                lines: [{ claimRef, shaAmount: "800.00", reason: "DEMO reconciliation" }],
              },
              cmdOpts,
            );
            bump("shaReconciliations");
          } catch (e) {
            skip("sha.reconcile", e instanceof Error ? e.message : String(e));
          }
        }
      }
    } else {
      skip(
        "sha.claimLifecycle",
        "Missing SHA patient/encounter/invoice/payer/empanelment/benefit package; claim lifecycle skipped.",
      );
    }

    console.log("\n=== DEMO SEED SUMMARY ===");
    console.log(`Facility: ${FACILITY_NAME}`);
    console.log(`Facility code: ${FACILITY_CODE}`);
    console.log(`Facility ID: ${facilityId}`);
    console.log(`Branch: ${BRANCH_NAME} (${BRANCH_CODE})`);
    console.log("Created/ensured counts:");
    for (const [k, v] of Object.entries(summary.created).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  - ${k}: ${v}`);
    }
    if (summary.skipped.length > 0) {
      console.log("Skipped steps:");
      for (const s of summary.skipped) {
        console.log(`  - ${s.step}: ${s.reason}`);
      }
    } else {
      console.log("Skipped steps: none");
    }
    console.log("\nLOCAL-ONLY DEMO REMINDER:");
    console.log("- This script seeds DEMO data for local development/testing only.");
    console.log("\nLOCAL-ONLY DEMO REMINDER:");
    console.log("- This script seeds DEMO data for local development/testing only.");
    console.log("- Do not run against remote/Neon/prod databases.");
    console.log("- REGDEMO-* facility is used so command outbox sync capture is suppressed.");
    console.log("- All seeded records are marked DEMO where applicable.");
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("db:seed:demo failed:", message);
  process.exit(1);
});
