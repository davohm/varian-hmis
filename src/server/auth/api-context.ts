import type { NextRequest } from "next/server";

import type { CommandActor } from "@/server/commands/run";
import type { Role } from "@/server/db/schema";

import { ForbiddenError } from "./rbac";
import { getSessionContext, requireApiStaff } from "./guards";

/** Resolve the active facility for a route handler and enforce its role guard. */
export async function requireApiFacility(roles: Role[]) {
  const context = await getSessionContext();
  const facilityId = context?.activeFacilityId ?? null;
  const branchId = context?.activeBranchId ?? null;
  if (!facilityId) throw new ForbiddenError("No active facility");

  const staff = await requireApiStaff(roles, facilityId, branchId);
  return { context, facilityId, branchId, staff };
}

export function actorFromRequest(request: NextRequest, userId: string): CommandActor {
  return {
    userId,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    deviceId: request.headers.get("x-device-id"),
  };
}
