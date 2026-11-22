import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { bootstrapFirstRun, getFirstRunStatus } from "../src/server/commands/bootstrap";
import { createDatabase } from "../src/server/db/client";
import { DATABASE_URL } from "../src/server/env";

type InstallConfig = {
  idempotencyKey: string;
  admin: {
    name: string;
    email: string;
    password: string;
    phone?: string | null;
    staffNumber?: string;
  };
  facility: {
    code: string;
    name: string;
    registrationDetails?: string | null;
    physicalAddress?: string | null;
    county?: string | null;
    phone?: string | null;
    email?: string | null;
    logoUrl?: string | null;
    currency?: string;
    timezone?: string;
    writeAuthority?: "cloud" | "clinic";
  };
  branches: Array<{
    code: string;
    name: string;
    physicalLocation?: string | null;
    telephone?: string | null;
    managerName?: string | null;
    isMain?: boolean;
  }>;
};

function usage(): never {
  console.error(
    "Usage: tsx scripts/install-first-run.ts --config <path-to-json>\n" +
      "The config file must include idempotencyKey, admin, facility, and branches.\n" +
      "Password is read from the config file; do not pass secrets on the command line.",
  );
  process.exit(1);
}

async function readConfig(): Promise<InstallConfig> {
  const argIndex = process.argv.indexOf("--config");
  const configPath = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.INSTALL_CONFIG_PATH;
  if (!configPath) usage();

  const absolute = resolve(process.cwd(), configPath);
  const raw = await readFile(absolute, "utf8");
  return JSON.parse(raw) as InstallConfig;
}

async function main() {
  const config = await readConfig();
  const { db, pool } = createDatabase(DATABASE_URL);
  try {
    const status = await getFirstRunStatus(db);
    if (!status.required) {
      console.error("Initial setup is already complete.");
      console.error(JSON.stringify({ facilityCount: status.facilityCount, superAdminCount: status.superAdminCount }));
      process.exit(2);
    }

    const result = await bootstrapFirstRun(config, { database: db });
    const safeResult = {
      ok: true,
      facilityId: (result as { facilityId?: string }).facilityId,
      facilityCode: (result as { facilityCode?: string }).facilityCode,
      adminUserId: (result as { adminUserId?: string }).adminUserId,
      adminEmail: (result as { adminEmail?: string }).adminEmail,
      branchCount: Array.isArray((result as { branchIds?: unknown[] }).branchIds)
        ? ((result as { branchIds: unknown[] }).branchIds.length)
        : undefined,
    };
    console.log(JSON.stringify(safeResult, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
