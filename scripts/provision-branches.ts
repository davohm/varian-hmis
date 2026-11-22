/**
 * Provisions the Ruaka and Thika branch facilities on the Nairobi HQ (cloud)
 * database. Run this only on HQ after `npm run db:migrate && npm run db:seed`.
 *
 * The script is idempotent: existing facilities, branches and sync tokens are
 * left alone unless a replacement token is supplied through the environment.
 * A generated raw token is printed exactly once; it is never stored in the
 * repository, the database or a command log.
 */
import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import { createDatabase } from "../src/server/db/client";
import { APP_MODE, DATABASE_URL } from "../src/server/env";
import { branches, facilities } from "../src/server/db/schema";
import { facilitySyncTokens } from "../src/server/db/schema/sync";
import { hashSyncToken } from "../src/server/sync/auth";
import { upsertFacilityPrices } from "./billing-catalog";

interface BranchSeed {
  code: string;
  name: string;
  county: string;
  tokenEnv: string;
  deviceEnv: string;
  branchIdEnv: string;
}

const BRANCHES: BranchSeed[] = [
  {
    code: "RUA",
    name: "Varian HMIS Ruaka Branch",
    county: "Kiambu",
    tokenEnv: "RUAKA_SYNC_TOKEN",
    deviceEnv: "RUAKA_DEVICE_KEY",
    branchIdEnv: "RUAKA_BRANCH_ID",
  },
  {
    code: "THK",
    name: "Varian HMIS Thika Branch",
    county: "Kiambu",
    tokenEnv: "THIKA_SYNC_TOKEN",
    deviceEnv: "THIKA_DEVICE_KEY",
    branchIdEnv: "THIKA_BRANCH_ID",
  },
];

function suppliedToken(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length >= 16 ? value : null;
}

function suppliedUuid(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} is not a valid UUID: ${value}`);
  }
  return value;
}

async function main() {
  if (APP_MODE !== "cloud") {
    throw new Error("provision:branches must run against the HQ cloud database (APP_MODE=cloud)");
  }

  const { pool, db } = createDatabase(DATABASE_URL);
  const summary: Array<Record<string, unknown>> = [];

  try {
    const hq = await db
      .select({ id: facilities.id, writeAuthority: facilities.writeAuthority })
      .from(facilities)
      .where(eq(facilities.code, "FAM"))
      .limit(1);
    if (!hq[0]) {
      throw new Error("HQ facility FAM is missing; run npm run db:migrate && npm run db:seed first");
    }
    if (hq[0].writeAuthority !== "cloud") {
      throw new Error("HQ facility FAM must have write_authority = cloud before branches are added");
    }

    for (const branch of BRANCHES) {
      let facility = await db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.code, branch.code))
        .limit(1);

      if (!facility[0]) {
        const inserted = await db
          .insert(facilities)
          .values({
            id: newId(),
            code: branch.code,
            name: branch.name,
            county: branch.county,
            writeAuthority: "clinic",
            timezone: "Africa/Nairobi",
            createdBy: "provision-branches",
          })
          .onConflictDoNothing({ target: facilities.code })
          .returning({ id: facilities.id });
        facility = inserted.length > 0 ? inserted : await db
          .select({ id: facilities.id })
          .from(facilities)
          .where(eq(facilities.code, branch.code))
          .limit(1);
      }
      if (!facility[0]) throw new Error(`Could not provision facility ${branch.code}`);
      const facilityId = facility[0].id;

      const suppliedBranchId = suppliedUuid(branch.branchIdEnv);
      let branchRow = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.facilityId, facilityId), eq(branches.code, "MAIN")))
        .limit(1);

      if (branchRow[0] && suppliedBranchId && branchRow[0].id !== suppliedBranchId) {
        throw new Error(
          `${branch.code} MAIN branch already has id ${branchRow[0].id}, which does not match ` +
            `${branch.branchIdEnv}=${suppliedBranchId}.`,
        );
      }

      if (!branchRow[0]) {
        const insertedBranch = await db
          .insert(branches)
          .values({
            id: suppliedBranchId ?? newId(),
            facilityId,
            code: "MAIN",
            name: "Main Branch",
            isMain: true,
            createdBy: "provision-branches",
          })
          .onConflictDoNothing({ target: [branches.facilityId, branches.code] })
          .returning({ id: branches.id });
        branchRow = insertedBranch.length > 0 ? insertedBranch : await db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.facilityId, facilityId), eq(branches.code, "MAIN")))
          .limit(1);
      }
      if (!branchRow[0]) throw new Error(`Could not provision MAIN branch for ${branch.code}`);
      const branchId = branchRow[0].id;

      // Branch nodes do not seed their own prices: create them here against the
      // HQ catalog so the first pull has facility-scoped price rows to apply.
      const billing = await upsertFacilityPrices(db, facilityId);

      const deviceKey = process.env[branch.deviceEnv]?.trim() || "clinic-server";
      const existing = await db
        .select({ id: facilitySyncTokens.id })
        .from(facilitySyncTokens)
        .where(
          and(
            eq(facilitySyncTokens.facilityId, facilityId),
            eq(facilitySyncTokens.deviceKey, deviceKey),
          ),
        )
        .limit(1);

      const supplied = suppliedToken(branch.tokenEnv);
      let tokenStatus: "generated" | "created-from-env" | "rotated" | "existing";
      let rawToken: string | null = null;

      if (supplied) {
        await db
          .insert(facilitySyncTokens)
          .values({
            id: newId(),
            facilityId,
            deviceKey,
            tokenHash: hashSyncToken(supplied),
            active: true,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          })
          .onConflictDoUpdate({
            target: [facilitySyncTokens.facilityId, facilitySyncTokens.deviceKey],
            set: {
              tokenHash: hashSyncToken(supplied),
              active: true,
              createdAt: new Date(),
              lastUsedAt: null,
              expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
              revokedAt: null,
            },
          });
        tokenStatus = existing[0] ? "rotated" : "created-from-env";
      } else if (!existing[0]) {
        rawToken = randomBytes(32).toString("base64url");
        await db.insert(facilitySyncTokens).values({
          id: newId(),
          facilityId,
          deviceKey,
          tokenHash: hashSyncToken(rawToken),
          active: true,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        });
        tokenStatus = "generated";
      } else {
        tokenStatus = "existing";
      }

      summary.push({
        code: branch.code,
        facilityId,
        branchId,
        writeAuthority: "clinic",
        deviceKey,
        tokenStatus,
        billing,
        ...(rawToken ? { token: rawToken } : {}),
      });
    }

    console.log(
      JSON.stringify(
        {
          hq: { code: "FAM", facilityId: hq[0].id, writeAuthority: "cloud" },
          branches: summary,
          note: "Copy each configured/generated token, facilityId and branchId into that branch's env file immediately; a generated token is shown once.",
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
