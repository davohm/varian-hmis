import { and, asc, eq, inArray } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "./auth";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeStaffAccess,
  primaryRoleFor,
  type StaffScope,
} from "./rbac";
import { db } from "@/server/db/client";
import {
  branches,
  facilities,
  staffProfiles,
  staffRoleScopes,
  type Role,
} from "@/server/db/schema";

export const ACTIVE_FACILITY_COOKIE = "varian_active_facility";
export const ACTIVE_BRANCH_COOKIE = "varian_active_branch";

export {
  ForbiddenError,
  UnauthorizedError,
  authorizeStaffAccess,
  primaryRoleFor,
  type StaffScope,
} from "./rbac";

export const getScopes = cache(async (userId: string): Promise<StaffScope[]> => {
  const rows = await db
    .select({
      role: staffRoleScopes.role,
      facilityId: facilities.id,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      branchId: branches.id,
      branchCode: branches.code,
      branchName: branches.name,
    })
    .from(staffRoleScopes)
    .innerJoin(staffProfiles, eq(staffRoleScopes.userId, staffProfiles.userId))
    .innerJoin(facilities, eq(staffRoleScopes.facilityId, facilities.id))
    .leftJoin(
      branches,
      and(eq(staffRoleScopes.branchId, branches.id), eq(branches.facilityId, facilities.id)),
    )
    .where(and(eq(staffRoleScopes.userId, userId), eq(staffProfiles.isActive, true)))
    .orderBy(asc(facilities.code), asc(branches.code));

  return rows;
});

export const getStaffSession = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const scopes = await getScopes(session.user.id);
  if (scopes.length === 0) return null;

  return { user: session.user, session, scopes };
});

async function readActiveSelection() {
  const jar = await cookies();
  return {
    facilityId: jar.get(ACTIVE_FACILITY_COOKIE)?.value ?? null,
    branchId: jar.get(ACTIVE_BRANCH_COOKIE)?.value ?? null,
  };
}

async function assertBranchBelongsToFacility(facilityId: string, branchId: string | null) {
  if (!branchId || !facilityId) return;
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new ForbiddenError("Active branch is outside the active facility");
}

export async function requireStaff(roles: Role[], facilityId?: string) {
  const staff = await getStaffSession();
  if (!staff) redirect("/login");

  const active = await readActiveSelection();
  const resolvedFacilityId = facilityId ?? active.facilityId;
  if (!resolvedFacilityId) redirect("/api/session/repair");
  if (facilityId && active.facilityId && facilityId !== active.facilityId) {
    throw new ForbiddenError("Facility does not match the active facility");
  }

  await assertBranchBelongsToFacility(resolvedFacilityId, active.branchId);

  if (!authorizeStaffAccess(staff.scopes, roles, resolvedFacilityId, active.branchId)) {
    throw new ForbiddenError();
  }

  return {
    ...staff,
    facilityId: resolvedFacilityId,
    branchId: active.branchId,
    role: primaryRoleFor(staff.scopes, roles),
  };
}

/** Page guards turn ForbiddenError into a dedicated, authenticated 403 page. */
export async function requireScreen(roles: Role[]) {
  try {
    return await requireStaff(roles);
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/forbidden");
    throw error;
  }
}

export async function getApiStaff() {
  return getStaffSession();
}

export async function requireApiStaff(
  roles: Role[],
  facilityId: string | null,
  branchId?: string | null,
) {
  const staff = await getApiStaff();
  if (!staff) throw new UnauthorizedError();

  await assertBranchBelongsToFacility(facilityId ?? "", branchId ?? null);

  if (!authorizeStaffAccess(staff.scopes, roles, facilityId, branchId)) {
    throw new ForbiddenError();
  }
  return { ...staff, role: primaryRoleFor(staff.scopes, roles) };
}

export interface SessionFacility {
  id: string;
  code: string;
  name: string;
  branches: Array<{ id: string; code: string; name: string }>;
}

export async function getSessionContext() {
  const staff = await getStaffSession();
  if (!staff) return null;

  const facilityIds = [...new Set(staff.scopes.map((scope) => scope.facilityId))];
  const facilityRows = facilityIds.length
    ? await db.select().from(facilities).where(inArray(facilities.id, facilityIds))
    : [];
  const branchRows = facilityIds.length
    ? await db.select().from(branches).where(inArray(branches.facilityId, facilityIds))
    : [];

  const facilityMap = new Map<string, SessionFacility>();
  for (const facility of facilityRows) {
    facilityMap.set(facility.id, {
      id: facility.id,
      code: facility.code,
      name: facility.name,
      branches: [],
    });
  }
  for (const branch of branchRows) {
    facilityMap.get(branch.facilityId)?.branches.push({
      id: branch.id,
      code: branch.code,
      name: branch.name,
    });
  }

  const availableFacilities = [...facilityMap.values()];
  const active = await readActiveSelection();
  const activeFacility =
    availableFacilities.find((facility) => facility.id === active.facilityId) ??
    availableFacilities[0] ??
    null;
  const activeBranch =
    activeFacility?.branches.find((branch) => branch.id === active.branchId) ?? null;

  return {
    user: staff.user,
    scopes: staff.scopes,
    facilities: availableFacilities,
    activeFacilityId: activeFacility?.id ?? null,
    activeBranchId: activeBranch?.id ?? null,
  };
}
