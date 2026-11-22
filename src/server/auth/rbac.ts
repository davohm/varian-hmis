import type { Role } from "@/server/db/schema/staff";

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this action.") {
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

export const ADMIN_LIKE_ROLES: readonly Role[] = ["admin", "super_admin"];

export function isAdminLikeRole(role: Role | null | undefined): role is "admin" | "super_admin" {
  return role === "admin" || role === "super_admin";
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

  return candidates.some((scope) => isAdminLikeRole(scope.role) || roles.includes(scope.role));
}

export function primaryRoleFor(scopes: StaffScope[], roles: Role[]): Role | null {
  // The shell asks for no specific role. A multi-role administrator must still
  // see the Administration workspace even when another scope is listed first.
  if (roles.length === 0) {
    return (
      scopes.find((scope) => scope.role === "super_admin")?.role ??
      scopes.find((scope) => scope.role === "admin")?.role ??
      scopes[0]?.role ??
      null
    );
  }

  const matching = scopes.find((scope) => roles.includes(scope.role));
  return matching?.role ?? scopes[0]?.role ?? null;
}
