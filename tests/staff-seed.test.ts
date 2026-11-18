import { verifyPassword } from "better-auth/crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/server/db/client";
import {
  account,
  branches,
  facilities,
  staffProfiles,
  staffRoleScopes,
  user,
  type Role,
} from "../src/server/db/schema";

const { pool, db } = createDatabase(process.env.DATABASE_URL!);

const STAFF: Array<{ role: Role; email: string; staffNumber: string }> = [
  { role: "receptionist", email: "receptionist@fam.test", staffNumber: "FAM-R001" },
  { role: "triage_nurse", email: "triage@fam.test", staffNumber: "FAM-T001" },
  { role: "doctor", email: "doctor@fam.test", staffNumber: "FAM-D001" },
  { role: "lab_tech", email: "lab@fam.test", staffNumber: "FAM-L001" },
  { role: "pharmacist", email: "pharmacist@fam.test", staffNumber: "FAM-P001" },
  { role: "cashier", email: "cashier@fam.test", staffNumber: "FAM-C001" },
  { role: "admin", email: "admin@fam.test", staffNumber: "FAM-A001" },
];

afterAll(async () => {
  await pool.end();
});

describe("seeded staff accounts", () => {
  it("provisions one active user with a verified credential per role", async () => {
    const users = await db
      .select()
      .from(user)
      .where(inArray(user.email, STAFF.map((item) => item.email)));
    expect(users).toHaveLength(STAFF.length);

    for (const expected of STAFF) {
      const found = users.find((item) => item.email === expected.email);
      expect(found).toBeDefined();
      expect(found!.role).toBe(expected.role);
      expect(found!.emailVerified).toBe(true);

      const profile = await db
        .select()
        .from(staffProfiles)
        .where(eq(staffProfiles.userId, found!.id));
      expect(profile).toHaveLength(1);
      expect(profile[0]!.staffNumber).toBe(expected.staffNumber);
      expect(profile[0]!.isActive).toBe(true);

      const accounts = await db.select().from(account).where(eq(account.userId, found!.id));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.providerId).toBe("credential");
      expect(accounts[0]!.password).toBeTruthy();
      expect(
        await verifyPassword({ hash: accounts[0]!.password!, password: "VarianHMIS2026!" }),
      ).toBe(true);
    }
  });

  it("scopes every seeded role to FAM with access to all branches", async () => {
    const facility = await db.select().from(facilities).where(eq(facilities.code, "FAM")).limit(1);
    expect(facility).toHaveLength(1);

    const users = await db
      .select()
      .from(user)
      .where(inArray(user.email, STAFF.map((item) => item.email)));

    for (const found of users) {
      const scopes = await db
        .select()
        .from(staffRoleScopes)
        .where(
          and(
            eq(staffRoleScopes.userId, found.id),
            eq(staffRoleScopes.facilityId, facility[0]!.id),
          ),
        );
      expect(scopes).toHaveLength(1);
      expect(scopes[0]!.branchId).toBeNull();
      expect(scopes[0]!.role).toBe(found.role);
    }

    const famBranches = await db
      .select()
      .from(branches)
      .where(eq(branches.facilityId, facility[0]!.id));
    expect(famBranches.some((branch) => branch.code === "MAIN")).toBe(true);
  });
});
