import type { Role } from "@/server/db/schema/staff";

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface StaffScope {
  role: Role;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  branchId: string | null;
  branchCode: string | null;
  branchName: string | null;
}

/** Pure rule: role/admin override, facility scope and nullable branch scope. */
export function authorizeStaffAccess(
  scopes: StaffScope[],
  roles: Role[],
  facilityId: string | null | undefined,
  branchId?: string | null,
) {
  if (!facilityId) return false;

  const candidates = scopes.filter(
    (scope) =>
      scope.facilityId === facilityId &&
      (!branchId || scope.branchId === null || scope.branchId === branchId),
  );

  if (roles.length === 0) return candidates.length > 0;

  return candidates.some((scope) => scope.role === "admin" || roles.includes(scope.role));
}

export function primaryRoleFor(scopes: StaffScope[], roles: Role[]): Role | null {
  const matching = scopes.find((scope) => roles.length === 0 || roles.includes(scope.role));
  return matching?.role ?? scopes[0]?.role ?? null;
}
