import { sql, type SQL } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

import { writeSyncState } from "./outbox";
import { facilityColumnForTable, SYNC_INBOUND_TABLES } from "./registry";
import type { PullRow } from "./types";

const FACILITY_OR_GLOBAL_TABLES = new Set([
  "items",
  "lab_tests",
  "services",
  "price_lists",
  "prices",
]);

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

function identifier(name: string): SQL {
  // The caller only ever passes a name from SYNC_INBOUND_TABLES.
  return sql.raw(`"${name}"`);
}

function scopeCondition(tableName: string, facilityId: string): SQL {
  const column = facilityColumnForTable(tableName);
  if (!column) return sql``;
  if (tableName === "facilities") {
    return sql`AND id = ${facilityId}::uuid`;
  }
  if (FACILITY_OR_GLOBAL_TABLES.has(tableName)) {
    return sql`AND (facility_id = ${facilityId}::uuid OR facility_id IS NULL)`;
  }
  return sql`AND facility_id = ${facilityId}::uuid`;
}

export async function readPullRows(
  executor: DbExecutor,
  facilityId: string,
  since: Date,
): Promise<PullRow[]> {
  const rows: PullRow[] = [];

  for (const tableName of SYNC_INBOUND_TABLES) {
    const result = await executor.execute(sql`
      SELECT * FROM ${identifier(tableName)}
      WHERE updated_at > ${since.toISOString()}::timestamptz
      ${scopeCondition(tableName, facilityId)}
      ORDER BY updated_at, id
      LIMIT 1000
    `);
    for (const payload of rowsFrom(result)) {
      rows.push({ tableName, payload });
    }
  }

  return rows;
}

/** Apply cloud-owned rows locally without re-entering the outbox. */
export async function applyPullRows(
  executor: DbExecutor,
  rows: PullRow[],
  pulledAt: string,
): Promise<void> {
  await executor.execute(sql`SET LOCAL varian.sync_apply = 'on'`);

  for (const row of rows) {
    await executor.execute(sql`
      SELECT apply_sync_row(${row.tableName}::text, ${JSON.stringify(row.payload)}::jsonb, true::boolean) AS applied
    `);
  }

  await writeSyncState(executor, "last_pulled_at", { timestamp: pulledAt });
}
