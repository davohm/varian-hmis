import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import { recordAudit } from "../src/server/audit";
import { APP_MODE, DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import {
  account,
  branches,
  facilities,
  staffProfiles,
  staffRoleScopes,
  stores,
  user,
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
