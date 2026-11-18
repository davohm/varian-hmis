import { eq } from "drizzle-orm";

import { db } from "@/server/db/client";
import { facilities, staffRoleScopes, user } from "@/server/db/schema";
import { recordAudit } from "@/server/audit";

interface AuthAuditInput {
  action: "auth.sign_in" | "auth.sign_in.failed" | "auth.sign_out";
  userId?: string | null;
  email?: string | null;
  headers?: Headers | null;
}

function clientIp(headers?: Headers | null) {
  const forwarded = headers?.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || headers?.get("x-real-ip") || null;
}

async function resolveFacilityId(userId?: string | null, email?: string | null) {
  let resolvedUserId = userId ?? null;

  if (!resolvedUserId && email) {
    const found = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    resolvedUserId = found[0]?.id ?? null;
  }

  if (resolvedUserId) {
    const scope = await db
      .select({ facilityId: staffRoleScopes.facilityId })
      .from(staffRoleScopes)
      .where(eq(staffRoleScopes.userId, resolvedUserId))
      .limit(1);
    if (scope[0]) return scope[0].facilityId;
  }

  const fallback = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.code, "FAM"))
    .limit(1);
  return fallback[0]?.id ?? null;
}

/** Audit authentication events. Never include credentials in the details. */
export async function recordAuthAudit(input: AuthAuditInput) {
  const facilityId = await resolveFacilityId(input.userId, input.email);
  if (!facilityId) return;

  await recordAudit(db, {
    facilityId,
    userId: input.userId ?? null,
    action: input.action,
    module: "auth",
    entity: "user",
    entityId: input.userId ?? input.email ?? null,
    details: input.email ? { email: input.email } : {},
    deviceId: input.headers?.get("user-agent")?.slice(0, 200) ?? null,
    ip: clientIp(input.headers),
  });
}
