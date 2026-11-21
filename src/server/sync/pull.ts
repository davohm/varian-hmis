import { sql, type SQL } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

import { pullCursorStateKey, pullStatusStateKey, writeSyncState } from "./outbox";
import { facilityColumnForTable, isInboundSyncTable, SYNC_INBOUND_TABLES } from "./registry";
import type {
  AdminOverridePull,
  OverrideCursor,
  PullCursor,
  PullCursorMap,
  PullRow,
} from "./types";

export const PULL_PAGE_SIZE = 1000;

const FACILITY_OR_GLOBAL_TABLES = new Set([
  "items",
  "lab_tests",
  "services",
  "price_lists",
  "prices",
]);

/** Auth tables use text ids; the rest of the inbound set uses uuid ids. */
const TEXT_ID_TABLES = new Set(["user", "account"]);

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

function identifier(name: string): SQL {
  // The caller only ever passes a name from SYNC_INBOUND_TABLES.
  return sql.raw(`"${name}"`);
}

/**
 * Cloud-owned auth/staff rows must be scoped to the pulling facility. Without
 * this, one facility's users overwrite another facility's users on every pull.
 */
function scopeCondition(tableName: string, facilityId: string): SQL {
  if (tableName === "facilities") {
    return sql`AND id = ${facilityId}::uuid`;
  }
  if (["user", "account", "staff_profiles"].includes(tableName)) {
    const column = tableName === "user" ? sql`id` : sql`user_id`;
    return sql`
      AND ${column} IN (
        SELECT user_id FROM staff_role_scopes WHERE facility_id = ${facilityId}::uuid
      )
    `;
  }
  if (!facilityColumnForTable(tableName)) return sql``;
  if (FACILITY_OR_GLOBAL_TABLES.has(tableName)) {
    return sql`AND (facility_id = ${facilityId}::uuid OR facility_id IS NULL)`;
  }
  return sql`AND facility_id = ${facilityId}::uuid`;
}

/** Keyset predicate: strictly after the last (updated_at, id) already returned. */
function cursorCondition(tableName: string, cursor: PullCursor | undefined): SQL {
  if (!cursor) return sql``;
  if (cursor.id === null) {
    return sql`AND updated_at > ${cursor.updatedAt}::timestamptz`;
  }
  if (TEXT_ID_TABLES.has(tableName)) {
    return sql`AND (updated_at, id) > (${cursor.updatedAt}::timestamptz, ${cursor.id}::text)`;
  }
  return sql`AND (updated_at, id) > (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * Never send OAuth tokens or provider secrets to a branch. The credential
 * account's password hash is kept because offline sign-in needs it.
 */
function selectedColumns(tableName: string): SQL {
  if (tableName === "account") {
    return sql`
      id, account_id, provider_id, user_id,
      NULL::text AS access_token,
      NULL::text AS refresh_token,
      NULL::text AS id_token,
      NULL::timestamptz AS access_token_expires_at,
      NULL::timestamptz AS refresh_token_expires_at,
      NULL::text AS scope,
      password, created_at, updated_at
    `;
  }
  return sql`*`;
}

export interface PullPage {
  rows: PullRow[];
  /** Next cursor for every inbound table, including tables with no new rows. */
  cursors: PullCursorMap;
  overrides: AdminOverridePull[];
  overrideCursor?: OverrideCursor;
}

export async function readPullRows(
  executor: DbExecutor,
  facilityId: string,
  cursors: PullCursorMap = {},
  limit = PULL_PAGE_SIZE,
  overrideCursor?: OverrideCursor,
): Promise<PullPage> {
  const rows: PullRow[] = [];
  const nextCursors: PullCursorMap = { ...cursors };
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), PULL_PAGE_SIZE);

  for (const tableName of SYNC_INBOUND_TABLES) {
    const result = await executor.execute(sql`
      SELECT
        ${selectedColumns(tableName)},
        to_char(
          updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS "cursorUpdatedAt"
      FROM ${identifier(tableName)}
      WHERE true
        ${scopeCondition(tableName, facilityId)}
        ${cursorCondition(tableName, cursors[tableName])}
      ORDER BY updated_at, id
      LIMIT ${pageSize}
    `);

    const pageRows = rowsFrom(result);
    for (const row of pageRows) {
      const { cursorUpdatedAt, ...payload } = row;
      rows.push({ tableName, payload });
      if (typeof cursorUpdatedAt === "string" && payload.id != null) {
        nextCursors[tableName] = {
          updatedAt: cursorUpdatedAt,
          id: String(payload.id),
        };
      }
    }
  }

  const overrideResult = await executor.execute(sql`
    SELECT
      id::text AS id,
      facility_id::text AS "facilityId",
      table_name AS "tableName",
      record_id AS "recordId",
      changes,
      based_on_version AS "basedOnVersion",
      reason,
      requested_by AS "requestedBy",
      status,
      created_at::text AS "createdAt",
      version,
      to_char(
        created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "cursorCreatedAt"
    FROM admin_overrides
    WHERE facility_id = ${facilityId}::uuid
      AND status = 'proposed'
      ${overrideCursor
        ? sql`AND (created_at, id) > (${overrideCursor.createdAt}::timestamptz, ${overrideCursor.id}::uuid)`
        : sql``}
    ORDER BY created_at, id
    LIMIT ${pageSize}
  `);
  const overrides: AdminOverridePull[] = [];
  let nextOverrideCursor = overrideCursor;
  for (const row of rowsFrom(overrideResult)) {
    const { cursorCreatedAt, ...data } = row;
    overrides.push(data as unknown as AdminOverridePull);
    if (typeof cursorCreatedAt === "string") {
      nextOverrideCursor = { createdAt: cursorCreatedAt, id: String(data.id) };
    }
  }

  return { rows, cursors: nextCursors, overrides, overrideCursor: nextOverrideCursor };
}

export function overrideCursorStateKey(facilityId: string): string {
  return `last_override_cursor:${facilityId}`;
}

/** Apply cloud-owned rows locally without re-entering the outbox. */
export async function applyPullRows(
  executor: DbExecutor,
  rows: PullRow[],
  facilityId: string,
  cursors?: PullCursorMap,
  pulledAt?: string,
  overrides: AdminOverridePull[] = [],
  overrideCursor?: OverrideCursor,
): Promise<void> {
  await executor.execute(sql`SET LOCAL varian.sync_apply = 'on'`);

  for (const row of rows) {
    if (!isInboundSyncTable(row.tableName)) {
      throw new Error(`${row.tableName} cannot be pulled from the cloud`);
    }
    await executor.execute(sql`
      SELECT apply_sync_row(${row.tableName}::text, ${JSON.stringify(row.payload)}::jsonb, true::boolean) AS applied
    `);
  }

  for (const override of overrides) {
    // Never overwrite a decision already recorded at the branch.
    await executor.execute(sql`
      INSERT INTO admin_overrides (
        id, facility_id, table_name, record_id, changes, based_on_version,
        reason, requested_by, status, created_at, updated_at, version
      ) VALUES (
        ${override.id}::uuid, ${facilityId}::uuid, ${override.tableName}, ${override.recordId},
        ${JSON.stringify(override.changes)}::jsonb, ${override.basedOnVersion},
        ${override.reason}, ${override.requestedBy}, 'proposed',
        ${override.createdAt}::timestamptz, now(), ${override.version}
      )
      ON CONFLICT (id) DO NOTHING
    `);
  }
  if (overrideCursor) {
    await writeSyncState(executor, overrideCursorStateKey(facilityId), overrideCursor);
  }

  if (cursors) {
    await writeSyncState(executor, pullCursorStateKey(facilityId), {
      tables: cursors,
      pulledAt: pulledAt ?? new Date().toISOString(),
    });
    await writeSyncState(executor, pullStatusStateKey(facilityId), {
      timestamp: pulledAt ?? new Date().toISOString(),
    });
  } else {
    // Older cloud deployments do not return cursors; keep the legacy checkpoint.
    await writeSyncState(executor, "last_pulled_at", {
      timestamp: pulledAt ?? new Date().toISOString(),
    });
  }
}
