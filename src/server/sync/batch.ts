import { sql } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

import {
  facilityColumnForTable,
  isAppendOnlySyncTable,
  isNoHardDeleteSyncTable,
} from "./registry";
import type { SyncRow } from "./types";

export class SyncBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncBatchError";
  }
}

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

function assertRowBelongsToFacility(row: SyncRow): void {
  const payload = row.payload;

  if (row.tableName === "facilities") {
    if (payload.id !== row.facilityId) {
      throw new SyncBatchError(`Facility row ${row.recordId} does not match the sync token facility`);
    }
    return;
  }

  const facilityColumn = facilityColumnForTable(row.tableName);
  if (!facilityColumn) {
    throw new SyncBatchError(`${row.tableName} cannot be pushed from a clinic`);
  }
  if (payload[facilityColumn] !== row.facilityId) {
    throw new SyncBatchError(`${row.tableName} row ${row.recordId} belongs to another facility`);
  }

  if (row.tableName === "number_sequences") {
    const expected = `${row.facilityId}:${payload.scope}:${payload.year}`;
    if (row.recordId !== expected) {
      throw new SyncBatchError(`Invalid business key for number sequence ${row.recordId}`);
    }
    return;
  }

  // Migration 0019 registers this table with the business key [facility_id],
  // so its outbox record_id is the facility UUID rather than the row id.
  if (row.tableName === "facility_regulatory_profiles") {
    if (row.recordId !== row.facilityId) {
      throw new SyncBatchError(
        `Invalid business key for facility regulatory profile ${row.recordId}`,
      );
    }
    return;
  }

  if (payload.id !== row.recordId) {
    throw new SyncBatchError(`${row.tableName} row id does not match its outbox record id`);
  }
}

/** Apply one verified batch in the caller's transaction. */
export async function applySyncBatch(
  executor: DbExecutor,
  facilityId: string,
  deviceKey: string,
  rows: SyncRow[],
): Promise<{ acceptedOutboxIds: string[] }> {
  const acceptedOutboxIds: string[] = [];

  for (const row of rows) {
    if (row.facilityId !== facilityId) {
      throw new SyncBatchError("Batch contains a row from another facility");
    }
    if (row.deviceKey !== deviceKey) {
      throw new SyncBatchError("Batch contains a row from another device");
    }
    assertRowBelongsToFacility(row);

    const received = await executor.execute(sql`
      INSERT INTO sync_received (outbox_id, facility_id, table_name, record_id)
      VALUES (
        ${row.outboxId}::uuid,
        ${facilityId}::uuid,
        ${row.tableName},
        ${row.recordId}
      )
      ON CONFLICT (outbox_id) DO NOTHING
      RETURNING outbox_id::text AS "outboxId"
    `);
    const isDuplicate = rowsFrom(received).length === 0;
    acceptedOutboxIds.push(row.outboxId);
    if (isDuplicate) continue;

    if (isAppendOnlySyncTable(row.tableName) && row.operation !== "INSERT") {
      throw new SyncBatchError(`${row.tableName} is append-only; ${row.operation} was rejected`);
    }
    if (row.operation === "DELETE" && isNoHardDeleteSyncTable(row.tableName)) {
      throw new SyncBatchError(
        `${row.tableName} cannot be hard-deleted; use a reversal, status change or new version`,
      );
    }

    const payload = JSON.stringify(row.payload);

    if (row.operation === "DELETE") {
      await executor.execute(sql`
        SELECT delete_sync_row(${row.tableName}::text, ${payload}::jsonb) AS deleted
      `);
    } else {
      await executor.execute(sql`
        SELECT apply_sync_row(${row.tableName}::text, ${payload}::jsonb, false::boolean) AS applied
      `);
    }
  }

  return { acceptedOutboxIds };
}
