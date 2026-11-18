import { z } from "zod";

import { recordAudit } from "@/server/audit";
import { ALL_ROLES, type Role } from "@/server/db/schema";

import { actorSchema, type CommandActor, type CommandTransaction } from "../run";

export const adminBaseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

export const roleSchema = z
  .string()
  .refine((value): value is Role => ALL_ROLES.includes(value as Role), "Unknown role");

export const moneySchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Use a money amount with at most two decimals");

export const codeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, numbers, dots, dashes or underscores");

export const scopeSchema = z.object({
  role: roleSchema,
  facilityId: z.uuid(),
  branchId: z.uuid().nullable().optional(),
});

export type AdminScopeInput = z.infer<typeof scopeSchema>;

export function requireActor(actor?: CommandActor | null): string {
  if (!actor?.userId) throw new Error("A signed-in user is required");
  return actor.userId;
}

interface AdminAuditInput {
  facilityId: string;
  actor?: CommandActor | null;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

/** All admin writes audit inside the same command transaction. */
export async function writeAdminAudit(tx: CommandTransaction, entry: AdminAuditInput) {
  return recordAudit(tx, {
    facilityId: entry.facilityId,
    userId: entry.actor?.userId ?? null,
    action: entry.action,
    module: "admin",
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    details: entry.details ?? {},
    deviceId: entry.actor?.deviceId ?? null,
    ip: entry.actor?.ip ?? null,
  });
}

export function verifyManagedFacilities(
  facilityIds: string[],
  allowedFacilityIds: string[] | undefined,
) {
  if (!allowedFacilityIds) return;
  const allowed = new Set(allowedFacilityIds);
  const rejected = facilityIds.find((facilityId) => !allowed.has(facilityId));
  if (rejected) throw new Error("Facility is outside your administration scope");
}

export function uniqueScopes(scopes: AdminScopeInput[]): AdminScopeInput[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = `${scope.role}:${scope.facilityId}:${scope.branchId ?? "all"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
