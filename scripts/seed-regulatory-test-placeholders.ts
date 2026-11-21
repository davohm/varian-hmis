/**
 * Provision a local-only regulatory placeholder sandbox in the FAM branch DB.
 *
 * The facility code uses REGDEMO- so `runCommand` suppresses outbox capture for
 * every write against it. No rows from this facility can reach Neon, and none
 * of the invented values are added to the real FAM facility.
 */
import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";

import { ADMIN_SECTIONS } from "../src/lib/admin-sections";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { loadRegulatoryTestPlaceholders } from "../src/server/commands/regulatory";
import { createDatabase } from "../src/server/db/client";
import {
  adminSectionPermissions,
  branches,
  facilities,
  staffProfiles,
  staffRoleScopes,
} from "../src/server/db/schema";
import { seedRegulatoryDefaults } from "../src/server/regulatory-seed";

const FACILITY_CODE = "REGDEMO-001";
const FACILITY_NAME = "TEST PLACEHOLDER - Regulatory sandbox (not FAM)";
const ADMIN_ID = "01a1fda9-c93c-72c5-95d7-321f74c07f25";

function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function main() {
  const url = readEnvFile(".env.branch-fam").DIRECT_DATABASE_URL;
  if (!url) throw new Error("Branch DIRECT_DATABASE_URL is required");

  const { db, pool } = createDatabase(url, "clinic");
  try {
    const existing = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.code, FACILITY_CODE))
      .limit(1);
    const facilityId = existing[0]?.id ?? newId();

    let staffProfileId: string | undefined;
    await db.transaction(async (tx) => {
      // Setup rows are local fixtures, not branch changes to be synced.
      await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);

      if (existing.length === 0) {
        await tx.insert(facilities).values({
          id: facilityId,
          code: FACILITY_CODE,
          name: FACILITY_NAME,
          county: "TEST COUNTY",
          writeAuthority: "clinic",
          active: true,
          createdBy: `admin:${ADMIN_ID}`,
        });
      } else {
        await tx
          .update(facilities)
          .set({
            name: FACILITY_NAME,
            county: "TEST COUNTY",
            writeAuthority: "clinic",
            active: true,
            updatedAt: new Date(),
          })
          .where(eq(facilities.id, facilityId));
      }

      const branchRows = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.facilityId, facilityId))
        .limit(1);
      if (branchRows.length === 0) {
        await tx.insert(branches).values({
          id: newId(),
          facilityId,
          code: "MAIN",
          name: "Test Main Branch",
          isMain: true,
          active: true,
          createdBy: `admin:${ADMIN_ID}`,
        });
      }

      const profileRows = await tx
        .select({ id: staffProfiles.id })
        .from(staffProfiles)
        .where(eq(staffProfiles.userId, ADMIN_ID))
        .limit(1);
      staffProfileId = profileRows[0]?.id;
      if (!staffProfileId) {
        throw new Error("The cloud administrator has no staff profile in the branch database");
      }

      const scopeRows = await tx
        .select({ id: staffRoleScopes.id })
        .from(staffRoleScopes)
        .where(eq(staffRoleScopes.facilityId, facilityId))
        .limit(1);
      if (scopeRows.length === 0) {
        await tx.insert(staffRoleScopes).values({
          id: newId(),
          userId: ADMIN_ID,
          role: "admin",
          facilityId,
          branchId: null,
        });
      }

      for (const section of ADMIN_SECTIONS) {
        const grantRows = await tx
          .select({ id: adminSectionPermissions.id })
          .from(adminSectionPermissions)
          .where(
            and(
              eq(adminSectionPermissions.userId, ADMIN_ID),
              eq(adminSectionPermissions.facilityId, facilityId),
              eq(adminSectionPermissions.section, section),
            ),
          )
          .limit(1);
        if (grantRows.length === 0) {
          await tx.insert(adminSectionPermissions).values({
            id: newId(),
            userId: ADMIN_ID,
            facilityId,
            section,
          });
        }
      }

      await seedRegulatoryDefaults(tx as unknown as Parameters<typeof seedRegulatoryDefaults>[0], facilityId, {
        createdBy: `admin:${ADMIN_ID}`,
      });
    });

    const result = await loadRegulatoryTestPlaceholders(
      {
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        actor: { userId: ADMIN_ID, deviceId: "seed-script" },
      },
      { database: db, mode: "clinic" },
    );

    console.log(
      JSON.stringify({
        facilityId,
        facilityCode: FACILITY_CODE,
        staffProfileConfigured: Boolean(staffProfileId),
        placeholder: result.placeholder,
        rows: result.rows,
        credentialsPrinted: false,
      }),
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  if (error instanceof Error && "cause" in error) {
    const cause = error.cause as Error | undefined;
    console.error("Cause:", cause?.message ?? cause);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
