/** Cleanup helper for test facilities left behind by an interrupted test run. */
import { createTestDatabase, cleanupTestFacility } from "../tests/helpers";
import { facilities } from "../src/server/db/schema";
import { like } from "drizzle-orm";

async function main() {
  const { db, pool } = createTestDatabase();
  try {
    const rows = await db
      .select({ id: facilities.id, code: facilities.code })
      .from(facilities)
      .where(like(facilities.code, "TEST-%"));
    for (const row of rows) {
      await cleanupTestFacility(db, row.id);
    }
    console.log(JSON.stringify({ removed: rows.length, codes: rows.map((row) => row.code) }));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
