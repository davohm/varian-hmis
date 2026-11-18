import { createHash, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import type { DbExecutor } from "@/server/numbering";

export class SyncAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "SyncAuthError";
  }
}

export function hashSyncToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export interface SyncPrincipal {
  tokenId: string;
  facilityId: string;
  deviceKey: string;
}

/**
 * Machine authentication for the sync endpoints. The token belongs to a
 * facility/device pair; the request body is never trusted to choose the tenant.
 */
export async function authorizeSyncToken(
  executor: DbExecutor,
  header: string | null,
  deviceKey: string,
  expectedFacilityId?: string,
): Promise<SyncPrincipal> {
  const token = bearerToken(header);
  if (!token) throw new SyncAuthError("A bearer sync token is required", 401);

  const result = await executor.execute(sql`
    SELECT
      t.id::text AS "tokenId",
      t.facility_id::text AS "facilityId",
      t.device_key AS "deviceKey",
      t.token_hash AS "tokenHash",
      f.write_authority AS "writeAuthority",
      f.active AS "facilityActive"
    FROM facility_sync_tokens t
    JOIN facilities f ON f.id = t.facility_id
    WHERE t.device_key = ${deviceKey}
      AND t.active = true
      AND t.revoked_at IS NULL
  `);

  const candidates = ((result as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .filter((row) => hashesMatch(String(row.tokenHash), hashSyncToken(token)));

  if (candidates.length !== 1) {
    throw new SyncAuthError("Invalid sync token", 401);
  }

  const candidate = candidates[0];
  if (candidate.facilityActive !== true) {
    throw new SyncAuthError("Facility is inactive", 403);
  }
  if (candidate.writeAuthority !== "clinic") {
    throw new SyncAuthError("Facility is not in clinic write mode", 403);
  }
  if (expectedFacilityId && candidate.facilityId !== expectedFacilityId) {
    throw new SyncAuthError("Sync token does not match the facility", 403);
  }

  await executor.execute(sql`
    UPDATE facility_sync_tokens SET last_used_at = now() WHERE id = ${candidate.tokenId}::uuid
  `);

  return {
    tokenId: String(candidate.tokenId),
    facilityId: String(candidate.facilityId),
    deviceKey: String(candidate.deviceKey),
  };
}
