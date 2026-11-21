import { sql } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

/**
 * Only demographic and setup/configuration fields may be proposed by central
 * admins. Clinical notes, lab results, payments, stock and other append-only
 * ledgers are deliberately absent: those need a reversal or a new version.
 */
export const OVERRIDE_FIELDS: Record<string, readonly string[]> = {
  patients: [
    "first_name",
    "last_name",
    "other_names",
    "dob",
    "dob_estimated",
    "sex",
    "national_id",
    "phone",
    "email",
    "address",
    "blood_group",
  ],
  facilities: ["name", "county", "phone", "email", "timezone"],
  branches: ["name"],
  departments: ["name", "kind"],
  rooms: ["name"],
  stores: ["name", "kind"],
  items: ["name", "unit", "strength", "form"],
  lab_tests: ["name", "sample_type"],
  price_lists: ["name"],
};

const DATE_FIELDS = new Set(["dob"]);
const BOOLEAN_FIELDS = new Set(["dob_estimated"]);
const SEX_VALUES = new Set(["male", "female", "intersex", "unknown"]);

export function isOverridableTable(tableName: string): boolean {
  return Object.hasOwn(OVERRIDE_FIELDS, tableName);
}

export function assertOverridableTable(tableName: string): void {
  if (!isOverridableTable(tableName)) {
    throw new Error(`${tableName} cannot be changed by a central override`);
  }
}

export function assertOverrideChanges(
  tableName: string,
  changes: Record<string, unknown>,
): void {
  assertOverridableTable(tableName);
  const allowed = OVERRIDE_FIELDS[tableName];
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new Error("At least one field is required");
  for (const [field, value] of entries) {
    if (!allowed.includes(field)) {
      throw new Error(`${field} cannot be changed by a central override`);
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`${field} must be a scalar value`);
    }
    if (typeof value === "string" && value.length > 1000) {
      throw new Error(`${field} is too long`);
    }
    if (BOOLEAN_FIELDS.has(field) && value !== null && typeof value !== "boolean") {
      throw new Error(`${field} must be true or false`);
    }
    if (DATE_FIELDS.has(field) && typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${field} must be a YYYY-MM-DD date`);
    }
    if (field === "sex" && typeof value === "string" && !SEX_VALUES.has(value.toLowerCase())) {
      throw new Error("sex must be male, female, intersex or unknown");
    }
  }
}

function tableIdentifier(tableName: string) {
  // Callers only reach here after isOverridableTable() passes.
  return sql.raw(`"${tableName}"`);
}

/** Current version of the cloud's copy of a branch-owned record. */
export async function readOverrideTargetVersion(
  executor: DbExecutor,
  tableName: string,
  facilityId: string,
  recordId: string,
): Promise<number | null> {
  assertOverridableTable(tableName);
  const scope = tableName === "facilities"
    ? sql`id = ${facilityId}::uuid AND id = ${recordId}::uuid`
    : sql`facility_id = ${facilityId}::uuid AND id = ${recordId}::uuid`;
  const result = await executor.execute(sql`
    SELECT version FROM ${tableIdentifier(tableName)} WHERE ${scope} LIMIT 1
  `);
  const row = (result as { rows?: Array<{ version?: number }> }).rows?.[0];
  return row?.version == null ? null : Number(row.version);
}

export interface AdminOverrideSummary {
  id: string;
  tableName: string;
  recordId: string;
  changes: Record<string, unknown>;
  basedOnVersion: number;
  reason: string;
  requestedBy: string;
  status: "proposed" | "applied" | "rejected" | "conflicted";
  decisionBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  version: number;
}

/** Override proposals and decisions visible to the active facility. */
export async function listAdminOverrides(
  executor: DbExecutor,
  facilityId: string,
  limit = 50,
): Promise<AdminOverrideSummary[]> {
  const result = await executor.execute(sql`
    SELECT
      id::text AS id,
      table_name AS "tableName",
      record_id AS "recordId",
      changes,
      based_on_version AS "basedOnVersion",
      reason,
      requested_by AS "requestedBy",
      status,
      decision_by AS "decisionBy",
      decision_reason AS "decisionReason",
      created_at::text AS "createdAt",
      version
    FROM admin_overrides
    WHERE facility_id = ${facilityId}::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 100)}
  `);
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map((row) => ({
    id: String(row.id),
    tableName: String(row.tableName),
    recordId: String(row.recordId),
    changes: (row.changes ?? {}) as Record<string, unknown>,
    basedOnVersion: Number(row.basedOnVersion),
    reason: String(row.reason ?? ""),
    requestedBy: String(row.requestedBy ?? ""),
    status: String(row.status) as AdminOverrideSummary["status"],
    decisionBy: row.decisionBy ? String(row.decisionBy) : null,
    decisionReason: row.decisionReason ? String(row.decisionReason) : null,
    createdAt: String(row.createdAt),
    version: Number(row.version),
  }));
}

export interface OverrideTarget {
  table: string;
  recordId: string;
  label: string;
  version: number;
}

const LABEL_EXPRESSION: Record<string, string> = {
  patients: `("first_name" || ' ' || "last_name" || ' · ' || "mrn")`,
  facilities: `"name"`,
  branches: `("code" || ' · ' || "name")`,
  departments: `"name"`,
  rooms: `"name"`,
  stores: `"name"`,
  items: `("code" || ' · ' || "name")`,
  lab_tests: `("code" || ' · ' || "name")`,
  price_lists: `"name"`,
};

/** Recent branch-owned records a central admin may propose a change for. */
export async function listOverrideTargets(
  executor: DbExecutor,
  facilityId: string,
  tableName: string,
  limit = 50,
): Promise<OverrideTarget[]> {
  assertOverridableTable(tableName);
  const scope = tableName === "facilities"
    ? sql`id = ${facilityId}::uuid`
    : sql`facility_id = ${facilityId}::uuid`;
  const label = sql.raw(LABEL_EXPRESSION[tableName] ?? '"name"');
  const result = await executor.execute(sql`
    SELECT id::text AS "recordId", ${label} AS label, version
    FROM ${tableIdentifier(tableName)}
    WHERE ${scope}
    ORDER BY updated_at DESC
    LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 100)}
  `);
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map((row) => ({
    table: tableName,
    recordId: String(row.recordId),
    label: String(row.label ?? row.recordId),
    version: Number(row.version),
  }));
}
