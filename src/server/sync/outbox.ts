import { sql, type SQL } from "drizzle-orm";

import { APP_MODE, SYNC_ENABLED } from "@/server/env";
import type { DbExecutor } from "@/server/numbering";

import type { SyncRow } from "./types";

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

/** Pull checkpoints are per facility so one branch cannot advance another's cursor. */
export function pullCursorStateKey(facilityId: string): string {
  return `last_pull_cursors:${facilityId}`;
}

export function pullStatusStateKey(facilityId: string): string {
  return `last_pulled_at:${facilityId}`;
}

export async function readPullCursors(
  executor: DbExecutor,
  facilityId: string,
): Promise<Record<string, { updatedAt: string; id: string | null }>> {
  const state = await readSyncState(executor, pullCursorStateKey(facilityId));
  const tables = state?.tables;
  if (!tables || typeof tables !== "object") return {};
  return tables as Record<string, { updatedAt: string; id: string | null }>;
}

function facilityCondition(facilityId?: string): SQL {
  return facilityId
    ? sql`AND facility_id = ${facilityId}::uuid`
    : sql``;
}

export async function listPendingRows(
  executor: DbExecutor,
  limit: number,
  facilityId?: string,
): Promise<SyncRow[]> {
  const result = await executor.execute(sql`
    SELECT
      outbox_id::text AS "outboxId",
      facility_id::text AS "facilityId",
      table_name AS "tableName",
      record_id AS "recordId",
      operation,
      payload,
      status,
      attempts,
      last_error AS "lastError",
      next_attempt_at AS "nextAttemptAt",
      created_at AS "createdAt"
    FROM sync_outbox
    WHERE status = 'pending'
      AND next_attempt_at <= now()
      ${facilityCondition(facilityId)}
    ORDER BY created_at, outbox_id
    LIMIT ${limit}
  `);

  return rowsFrom(result).map((row) => ({
    outboxId: String(row.outboxId),
    facilityId: String(row.facilityId),
    tableName: String(row.tableName),
    recordId: String(row.recordId),
    operation: String(row.operation) as SyncRow["operation"],
    payload: (row.payload ?? {}) as SyncRow["payload"],
    version: typeof row.version === "number" ? row.version : undefined,
  })) as SyncRow[];
}

export async function markRowsSynced(
  executor: DbExecutor,
  outboxIds: string[],
): Promise<void> {
  if (outboxIds.length === 0) return;
  await executor.execute(sql`
    UPDATE sync_outbox
    SET status = 'synced',
        synced_at = now(),
        last_error = NULL,
        next_attempt_at = now()
    WHERE outbox_id = ANY(${sql.param(outboxIds)}::uuid[])
  `);
}

export async function markRowsFailed(
  executor: DbExecutor,
  outboxIds: string[],
  error: string,
): Promise<void> {
  if (outboxIds.length === 0) return;
  const message = error.slice(0, 2000);
  await executor.execute(sql`
    UPDATE sync_outbox
    SET attempts = attempts + 1,
        last_error = ${message},
        status = CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE 'pending' END::sync_outbox_status,
        next_attempt_at = now() + (LEAST(2 ^ LEAST(attempts, 8), 300) * interval '1 second')
    WHERE outbox_id = ANY(${sql.param(outboxIds)}::uuid[])
  `);
}

export async function retryOutboxRows(
  executor: DbExecutor,
  outboxIds: string[],
  facilityId?: string,
): Promise<number> {
  if (outboxIds.length === 0) return 0;
  const result = await executor.execute(sql`
    UPDATE sync_outbox
    SET status = 'pending',
        attempts = 0,
        last_error = NULL,
        next_attempt_at = now()
    WHERE outbox_id = ANY(${sql.param(outboxIds)}::uuid[])
      AND status = 'failed'
      ${facilityCondition(facilityId)}
  `);
  return (result as { rowCount?: number }).rowCount ?? 0;
}

export async function readSyncState(
  executor: DbExecutor,
  key: string,
): Promise<Record<string, unknown> | null> {
  const result = await executor.execute(sql`
    SELECT value FROM sync_state WHERE key = ${key} LIMIT 1
  `);
  const row = rowsFrom(result)[0];
  return row ? (row.value as Record<string, unknown>) : null;
}

export async function writeSyncState(
  executor: DbExecutor,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
}

export interface SyncStatus {
  appMode: typeof APP_MODE;
  syncEnabled: boolean;
  pendingCount: number;
  oldestPendingSeconds: number | null;
  failedCount: number;
  lastSuccessAt: string | null;
  lastPulledAt: string | null;
  lastError: string | null;
}

export async function getSyncStatus(
  executor: DbExecutor,
  facilityId?: string,
): Promise<SyncStatus> {
  const result = await executor.execute(sql`
    SELECT
      (SELECT count(*)::int FROM sync_outbox WHERE status = 'pending' ${facilityCondition(facilityId)}) AS "pendingCount",
      (SELECT extract(epoch FROM now() - min(created_at))::float8 FROM sync_outbox WHERE status = 'pending' ${facilityCondition(facilityId)}) AS "oldestPendingSeconds",
      (SELECT count(*)::int FROM sync_outbox WHERE status = 'failed' ${facilityCondition(facilityId)}) AS "failedCount",
      (SELECT max(synced_at) FROM sync_outbox WHERE status = 'synced' ${facilityCondition(facilityId)}) AS "lastSuccessAt",
      (SELECT max(last_error) FROM sync_outbox WHERE status = 'failed' ${facilityCondition(facilityId)}) AS "lastError",
      (SELECT updated_at FROM sync_state WHERE key = ${facilityId ? pullStatusStateKey(facilityId) : 'last_pulled_at'}) AS "lastPulledAt"
  `);
  const row = rowsFrom(result)[0] ?? {};
  const lastPulled = await readSyncState(
    executor,
    facilityId ? pullStatusStateKey(facilityId) : "last_pulled_at",
  );

  return {
    appMode: APP_MODE,
    syncEnabled: SYNC_ENABLED,
    pendingCount: Number(row.pendingCount ?? 0),
    oldestPendingSeconds: row.oldestPendingSeconds == null
      ? null
      : Number(row.oldestPendingSeconds),
    failedCount: Number(row.failedCount ?? 0),
    lastSuccessAt: row.lastSuccessAt ? String(row.lastSuccessAt) : null,
    lastPulledAt: typeof lastPulled?.timestamp === "string"
      ? lastPulled.timestamp
      : row.lastPulledAt
        ? String(row.lastPulledAt)
        : null,
    lastError: row.lastError ? String(row.lastError) : null,
  };
}

export async function listFailedOutboxIds(
  executor: DbExecutor,
  facilityId: string,
  limit = 100,
): Promise<string[]> {
  const result = await executor.execute(sql`
    SELECT outbox_id::text AS "outboxId"
    FROM sync_outbox
    WHERE status = 'failed' AND facility_id = ${facilityId}::uuid
    ORDER BY created_at
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `);
  return rowsFrom(result).map((row) => String(row.outboxId));
}

export interface FailedSyncRow {
  outboxId: string;
  tableName: string;
  recordId: string;
  operation: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  payloadPreview: string;
}

export async function listFailedRows(
  executor: DbExecutor,
  facilityId: string,
  limit = 20,
): Promise<FailedSyncRow[]> {
  const result = await executor.execute(sql`
    SELECT
      outbox_id::text AS "outboxId",
      table_name AS "tableName",
      record_id AS "recordId",
      operation,
      attempts,
      last_error AS "lastError",
      created_at AS "createdAt",
      left(payload::text, 400) AS "payloadPreview"
    FROM sync_outbox
    WHERE status = 'failed' AND facility_id = ${facilityId}::uuid
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `);

  return rowsFrom(result).map((row) => ({
    outboxId: String(row.outboxId),
    tableName: String(row.tableName),
    recordId: String(row.recordId),
    operation: String(row.operation),
    attempts: Number(row.attempts ?? 0),
    lastError: row.lastError ? String(row.lastError) : null,
    createdAt: String(row.createdAt),
    payloadPreview: String(row.payloadPreview ?? ""),
  }));
}
