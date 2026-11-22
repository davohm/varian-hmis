import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newIdempotencyKey } from "../src/lib/uuid";
import { GET, POST } from "../src/app/api/setup/route";
import {
  bootstrapFirstRun,
  bootstrapFirstRunSchema,
  getFirstRunStatus,
} from "../src/server/commands/bootstrap";
import { DATABASE_URL } from "../src/server/env";
import {
  adminSectionPermissions,
  auditLog,
  branches,
  commandLog,
  facilities,
  staffRoleScopes,
  user,
} from "../src/server/db/schema";
import { createTestDatabase, type TestDatabase } from "./helpers";

let ctx: TestDatabase;

beforeAll(() => {
  ctx = createTestDatabase();
});

afterAll(async () => {
  await ctx.pool.end();
});

function bootstrapPayload() {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  return {
    idempotencyKey: newIdempotencyKey(),
    admin: {
      name: "Super Admin",
      email: `super-${suffix.toLowerCase()}@example.test`,
      password: "Passw0rd!123",
      phone: "0700000000",
      staffNumber: `SA-${suffix.slice(0, 6)}`,
    },
    facility: {
      code: `F${suffix.slice(0, 7)}`,
      name: `Facility ${suffix}`,
      registrationDetails: "REG-123",
      physicalAddress: "123 Main Street",
      county: "Nairobi",
      phone: "0711000000",
      email: `facility-${suffix.toLowerCase()}@example.test`,
      logoUrl: "https://example.test/logo.png",
      currency: "KES",
      timezone: "Africa/Nairobi",
      writeAuthority: "cloud" as const,
    },
    branches: [
      {
        code: "MAIN",
        name: "Main Branch",
        physicalLocation: "HQ Building",
        telephone: "0711000001",
        managerName: "Jane Manager",
        isMain: true,
      },
    ],
  };
}

describe("bootstrap first-run", () => {
  it("reports first-run as not required in a populated test database", async () => {
    const status = await getFirstRunStatus(ctx.db);
    expect(status.required).toBe(false);
    expect(status.facilityCount).toBeGreaterThan(0);
  });

  it("rejects bootstrap when installation is already complete", async () => {
    await expect(bootstrapFirstRun(bootstrapPayload(), { database: ctx.db })).rejects.toThrow(
      /already been completed/i,
    );
  });

  it("validates bootstrap payload shape", () => {
    const parsed = bootstrapFirstRunSchema.safeParse({
      idempotencyKey: "not-a-uuid",
      admin: {},
      facility: {},
      branches: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("bootstraps on a fresh database and is idempotent by key", async () => {
    const dbName = `vhmis_bootstrap_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const adminUrl = new URL(DATABASE_URL);
    const adminDb = adminUrl.pathname.replace(/^\//, "") || "postgres";
    const psql = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
    execFileSync(psql, [DATABASE_URL.replace(`/${adminDb}`, "/postgres"), "-c", `CREATE DATABASE ${dbName};`], {
      stdio: "pipe",
    });

    const tempUrl = DATABASE_URL.replace(`/${adminDb}`, `/${dbName}`);
    const pool = new Pool({ connectionString: tempUrl });
    const db = drizzle(pool);
    try {
      await migrate(db, { migrationsFolder: "drizzle" });

      const statusBefore = await getFirstRunStatus(db as never);
      expect(statusBefore).toEqual({ required: true, facilityCount: 0, superAdminCount: 0 });

      const payload = bootstrapPayload();
      const result = await bootstrapFirstRun(payload, { database: db as never }) as {
        ok: boolean;
        facilityId: string;
        adminUserId: string;
        branchIds: string[];
      };

      expect(result.ok).toBe(true);
      expect(result.facilityId).toBeTruthy();
      expect(result.adminUserId).toBeTruthy();
      expect(result.branchIds).toHaveLength(1);

      const [facility] = await db.select().from(facilities).where(eq(facilities.id, result.facilityId));
      expect(facility.code).toBe(payload.facility.code);
      expect(facility.registrationDetails).toBe(payload.facility.registrationDetails);
      expect(facility.physicalAddress).toBe(payload.facility.physicalAddress);
      expect(facility.logoUrl).toBe(payload.facility.logoUrl);
      expect(facility.currency).toBe(payload.facility.currency);

      const branchRows = await db.select().from(branches).where(eq(branches.facilityId, result.facilityId));
      expect(branchRows).toHaveLength(1);
      expect(branchRows[0].physicalLocation).toBe(payload.branches[0].physicalLocation);
      expect(branchRows[0].telephone).toBe(payload.branches[0].telephone);
      expect(branchRows[0].managerName).toBe(payload.branches[0].managerName);
      expect(branchRows[0].isMain).toBe(true);

      const [adminUser] = await db.select().from(user).where(eq(user.id, result.adminUserId));
      expect(adminUser.email).toBe(payload.admin.email);
      expect(adminUser.role).toBe("super_admin");

      const scopeRows = await db
        .select()
        .from(staffRoleScopes)
        .where(eq(staffRoleScopes.userId, result.adminUserId));
      expect(scopeRows).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "super_admin", facilityId: result.facilityId, branchId: null })]),
      );

      const permissionRows = await db
        .select()
        .from(adminSectionPermissions)
        .where(eq(adminSectionPermissions.userId, result.adminUserId));
      expect(permissionRows.length).toBeGreaterThan(0);

      const commandRows = await db
        .select()
        .from(commandLog)
        .where(eq(commandLog.idempotencyKey, payload.idempotencyKey));
      expect(commandRows).toHaveLength(1);
      expect(commandRows[0].command).toBe("bootstrapFirstRun");

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.facilityId, result.facilityId));
      expect(auditRows.some((row) => row.action === "bootstrap.first_run")).toBe(true);

      const replay = await bootstrapFirstRun(payload, { database: db as never });
      expect(replay).toEqual(result);

      const statusAfter = await getFirstRunStatus(db as never);
      expect(statusAfter.required).toBe(false);
    } finally {
      await pool.end();
      execFileSync(psql, [DATABASE_URL.replace(`/${adminDb}`, "/postgres"), "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`], {
        stdio: "pipe",
      });
    }
  }, 120000);
});

describe("setup API route", () => {
  it("GET reports status", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.required).toBe(false);
  });

  it("POST returns 409 when setup already complete", async () => {
    const request = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bootstrapPayload()),
    });
    const response = await POST(request);
    expect(response.status).toBe(409);
  });

  it("POST returns 409 for invalid payload when setup is already complete", async () => {
    const request = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bad: true }),
    });
    const response = await POST(request);
    expect(response.status).toBe(409);
  });
});
