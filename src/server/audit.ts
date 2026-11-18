import { eq, sql, type SQL } from "drizzle-orm";

import { newId } from "@/lib/uuid";

import { auditLog, commandLog } from "./db/schema";
import type { DbExecutor } from "./numbering";

export interface AuditEntry {
  facilityId: string;
  userId?: string | null;
  action: string;
  module: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  deviceId?: string | null;
  ip?: string | null;
}

type QueryResult = { rows?: Array<Record<string, unknown>> };

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as QueryResult).rows ?? [];
}

/** Append an audit event. Call inside the command transaction. */
export async function recordAudit(db: DbExecutor, entry: AuditEntry): Promise<string> {
  const id = newId();
  await db.execute(sql`
    INSERT INTO audit_log (
      id, facility_id, user_id, action, module, entity, entity_id,
      details, device_id, ip, created_at
    )
    VALUES (
      ${id}::uuid,
      ${entry.facilityId}::uuid,
      ${entry.userId ?? null}::text,
      ${entry.action}::text,
      ${entry.module}::text,
      ${entry.entity}::text,
      ${entry.entityId ?? null}::text,
      ${JSON.stringify(entry.details ?? {})}::jsonb,
      ${entry.deviceId ?? null}::text,
      ${entry.ip ?? null}::text,
      now()
    )
  `);
  return id;
}

export interface AuditFilters {
  userId?: string;
  action?: string;
  module?: string;
  entity?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listAudit(
  db: DbExecutor,
  facilityId: string,
  limitOrFilters: number | AuditFilters = 50,
  extraFilters: AuditFilters = {},
): Promise<Array<Record<string, unknown>>> {
  const filters = typeof limitOrFilters === "number" ? extraFilters : limitOrFilters;
  const limit = typeof limitOrFilters === "number" ? limitOrFilters : 50;
  const conditions: SQL[] = [sql`facility_id = ${facilityId}::uuid`];

  if (filters.userId) conditions.push(sql`user_id = ${filters.userId}`);
  if (filters.entityId) conditions.push(sql`entity_id = ${filters.entityId}`);
  if (filters.action) {
    conditions.push(sql`action ILIKE ${`%${escapeLike(filters.action)}%`} ESCAPE '\\'`);
  }
  if (filters.module) {
    conditions.push(sql`module ILIKE ${`%${escapeLike(filters.module)}%`} ESCAPE '\\'`);
  }
  if (filters.entity) {
    conditions.push(sql`entity ILIKE ${`%${escapeLike(filters.entity)}%`} ESCAPE '\\'`);
  }
  if (filters.from) conditions.push(sql`created_at >= ${filters.from}::timestamptz`);
  if (filters.to) conditions.push(sql`created_at <= ${filters.to}::timestamptz`);

  const result = await db.execute(sql`
    SELECT * FROM audit_log
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 200)}
  `);
  return rowsFrom(result);
}

export interface CommandRecord {
  facilityId: string;
  idempotencyKey: string;
  command: string;
  result: unknown;
}

/** Store a command result once. Replaying the same key is a no-op. */
export async function recordCommand(db: DbExecutor, entry: CommandRecord): Promise<void> {
  await db.execute(sql`
    INSERT INTO command_log (idempotency_key, facility_id, command, result, created_at)
    VALUES (
      ${entry.idempotencyKey}::uuid,
      ${entry.facilityId}::uuid,
      ${entry.command}::text,
      ${JSON.stringify(entry.result ?? {})}::jsonb,
      now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `);
}

export async function findCommand(
  db: DbExecutor,
  facilityId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const result = await db.execute(sql`
    SELECT * FROM command_log
    WHERE facility_id = ${facilityId}::uuid
      AND idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `);
  return rowsFrom(result)[0] ?? null;
}

// Re-exported for callers that need a typed Drizzle delete/select on command_log.
export { auditLog, commandLog, eq, type SQL };
