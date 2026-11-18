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
    SELECT p.id, p.mrn, p.first_name, p.last_name, p.other_names, p.phone, p.dob, p.sex
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
  }));
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
