import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { getSessionContext, requireApiStaff } from "@/server/auth/guards";
import { listAudit } from "@/server/audit";
import { db } from "@/server/db/client";

export async function GET() {
  try {
    const context = await getSessionContext();
    const facilityId = context?.activeFacilityId ?? null;
    await requireApiStaff(["admin"], facilityId, context?.activeBranchId ?? null);
    if (!facilityId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const events = await listAudit(db, facilityId, 100);
    return NextResponse.json({ events });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
