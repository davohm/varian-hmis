import { sql, type SQL } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

type QueryResult = { rows?: Array<Record<string, unknown>> };

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  return (result as QueryResult).rows ?? [];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

export interface PatientSearchResult {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
  nationalId: string | null;
  payerType: "cash" | "sha" | "insurance";
}

/**
 * Name search is backed by pg_trgm GIN indexes. MRN, phone and national ID
 * are included so a single search box covers all registry lookups.
 */
export async function searchPatients(
  db: DbExecutor,
  facilityId: string,
  query: string,
  limit = 10,
): Promise<PatientSearchResult[]> {
  const term = query.trim().toLowerCase();
  if (!term) return [];

  const fullName = sql`lower(p.first_name || ' ' || coalesce(p.other_names, '') || ' ' || p.last_name)`;
  const namePattern = `%${escapeLike(term)}%`;
  const prefixPattern = `${escapeLike(term)}%`;
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);

  const result = await db.execute(sql`
    SELECT
      p.id, p.mrn, p.first_name, p.last_name, p.other_names,
      p.phone, p.dob, p.sex, p.national_id, p.payer_type
    FROM patients p
    WHERE p.facility_id = ${facilityId}::uuid
      AND (
        lower(p.mrn) LIKE ${prefixPattern} ESCAPE '\\'
        OR lower(coalesce(p.phone, '')) LIKE ${namePattern} ESCAPE '\\'
        OR lower(coalesce(p.national_id, '')) LIKE ${prefixPattern} ESCAPE '\\'
        OR ${fullName} LIKE ${namePattern} ESCAPE '\\'
        OR similarity(${fullName}, ${term}) > 0.15
      )
    ORDER BY
      CASE WHEN lower(p.mrn) LIKE ${prefixPattern} ESCAPE '\\' THEN 0 ELSE 1 END,
      similarity(${fullName}, ${term}) DESC,
      p.last_name ASC,
      p.first_name ASC
    LIMIT ${safeLimit}
  `);

  return rowsFrom(result).map((row) => ({
    id: text(row.id),
    mrn: text(row.mrn),
    firstName: text(row.first_name),
    lastName: text(row.last_name),
    otherNames: row.other_names == null ? null : text(row.other_names),
    phone: row.phone == null ? null : text(row.phone),
    dob: row.dob == null ? null : text(row.dob),
    sex: text(row.sex),
    nationalId: row.national_id == null ? null : text(row.national_id),
    payerType: text(row.payer_type) as "cash" | "sha" | "insurance",
  }));
}

export interface PatientRegistryRow {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
  createdAt: string;
}

export interface PatientRegistryPage {
  rows: PatientRegistryRow[];
  total: number;
}

/**
 * Facility patient directory. An empty query returns the most recent records,
 * so reception can browse without guessing a name. Search reuses the same
 * trigram-backed matching as the check-in box.
 *
 * `total` is computed in the same statement with a window function, so a page
 * request does not pay for a second round trip. Postgres evaluates the window
 * before LIMIT/OFFSET, which gives the size of the full filtered result set.
 */
export async function listPatients(
  db: DbExecutor,
  facilityId: string,
  query: string,
  limit = 25,
  offset = 0,
): Promise<PatientRegistryPage> {
  const term = query.trim().toLowerCase();
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const safeOffset = Math.max(Math.trunc(offset), 0);
  const fullName = sql`lower(p.first_name || ' ' || coalesce(p.other_names, '') || ' ' || p.last_name)`;
  const namePattern = `%${escapeLike(term)}%`;
  const prefixPattern = `${escapeLike(term)}%`;

  const filter =
    term.length === 0
      ? sql`TRUE`
      : sql`(
          lower(p.mrn) LIKE ${prefixPattern} ESCAPE '\\'
          OR lower(coalesce(p.phone, '')) LIKE ${namePattern} ESCAPE '\\'
          OR lower(coalesce(p.national_id, '')) LIKE ${prefixPattern} ESCAPE '\\'
          OR ${fullName} LIKE ${namePattern} ESCAPE '\\'
          OR similarity(${fullName}, ${term}) > 0.15
        )`;

  const ordering =
    term.length === 0
      ? sql`p.created_at DESC, p.id DESC`
      : sql`similarity(${fullName}, ${term}) DESC, p.last_name ASC, p.first_name ASC, p.id ASC`;

  const result = await db.execute(sql`
    SELECT p.id, p.mrn, p.first_name, p.last_name, p.other_names, p.phone, p.dob, p.sex,
      p.created_at, count(*) OVER()::int AS total
    FROM patients p
    WHERE p.facility_id = ${facilityId}::uuid
      AND ${filter}
    ORDER BY ${ordering}
    LIMIT ${safeLimit}
    OFFSET ${safeOffset}
  `);

  const pageRows = rowsFrom(result);
  let total = pageRows[0]?.total == null ? 0 : Number(pageRows[0].total);

  // A page beyond the end has no rows to carry the window count. Only then do
  // we pay for a dedicated count so the caller can clamp back into range.
  if (total === 0 && safeOffset > 0) {
    const countResult = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM patients p
      WHERE p.facility_id = ${facilityId}::uuid
        AND ${filter}
    `);
    const countRows = rowsFrom(countResult);
    total = countRows[0]?.total == null ? 0 : Number(countRows[0].total);
  }

  return {
    rows: pageRows.map((row) => ({
      id: text(row.id),
      mrn: text(row.mrn),
      firstName: text(row.first_name),
      lastName: text(row.last_name),
      otherNames: row.other_names == null ? null : text(row.other_names),
      phone: row.phone == null ? null : text(row.phone),
      dob: row.dob == null ? null : text(row.dob),
      sex: text(row.sex),
      createdAt: text(row.created_at),
    })),
    total: Number.isFinite(total) ? total : 0,
  };
}

export interface DuplicateCriteria {
  phone?: string | null;
  dob?: string | null;
  nationalId?: string | null;
}

export interface DuplicateMatch {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  dob: string | null;
  matchReason: "national_id" | "phone_and_dob";
}

/** A duplicate is an exact national ID, or the same phone plus DOB. */
export async function findPatientDuplicates(
  db: DbExecutor,
  facilityId: string,
  criteria: DuplicateCriteria,
): Promise<DuplicateMatch[]> {
  const phone = criteria.phone?.trim() ?? "";
  const dob = criteria.dob?.trim() ?? "";
  const nationalId = criteria.nationalId?.trim() ?? "";
  const conditions: SQL[] = [];

  if (nationalId) {
    conditions.push(sql`upper(p.national_id) = ${nationalId.toUpperCase()}`);
  }
  if (phone && dob) {
    conditions.push(sql`p.phone = ${phone} AND p.dob::text = ${dob}`);
  }
  if (conditions.length === 0) return [];

  const result = await db.execute(sql`
    SELECT p.id, p.mrn, p.first_name, p.last_name, p.phone, p.dob,
      CASE WHEN ${nationalId} <> '' AND upper(p.national_id) = ${nationalId.toUpperCase()}
        THEN 'national_id' ELSE 'phone_and_dob' END AS match_reason
    FROM patients p
    WHERE p.facility_id = ${facilityId}::uuid
      AND (${sql.join(conditions, sql` OR `)})
    ORDER BY p.created_at DESC
    LIMIT 10
  `);

  return rowsFrom(result).map((row) => ({
    id: text(row.id),
    mrn: text(row.mrn),
    firstName: text(row.first_name),
    lastName: text(row.last_name),
    phone: row.phone == null ? null : text(row.phone),
    dob: row.dob == null ? null : text(row.dob),
    matchReason: text(row.match_reason) === "national_id" ? "national_id" : "phone_and_dob",
  }));
}
