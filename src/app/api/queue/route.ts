import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { ALL_ROLES } from "@/server/db/schema";
import { getActiveQueue } from "@/server/queries/queue";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(ALL_ROLES);
    const department = request.nextUrl.searchParams.get("department") ?? "Triage";
    const entries = await getActiveQueue(db, facilityId, department);
    return NextResponse.json({ entries });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
