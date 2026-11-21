/**
 * Mirror the system's safe regulatory setting defaults into a clinic database.
 *
 * `facility_settings` is not part of the inbound sync pull set, and override
 * proposals do not cover this table. This provisioning helper inserts only the
 * system-defined defaults from `REGULATORY_SETTINGS`; real regulator values
 * remain empty until an administrator enters and verifies them.
 */
import { readFileSync } from "node:fs";

import { createDatabase } from "../src/server/db/client";
import { missingRegulatorySettings, seedRegulatoryDefaults } from "../src/server/regulatory-seed";

const FACILITY_ID = "01a1fda9-b1d1-717a-9fe0-c3b523d937ec";
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
    const inserted = await seedRegulatoryDefaults(db, FACILITY_ID, {
      createdBy: `admin:${ADMIN_ID}`,
    });
    const missing = await missingRegulatorySettings(db, FACILITY_ID);
    console.log(JSON.stringify({ inserted, missing, credentialsPrinted: false }));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
