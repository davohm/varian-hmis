import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { ALL_ROLES } from "@/server/db/schema";
import { searchPatients } from "@/server/queries/patients";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(ALL_ROLES);
    const query = request.nextUrl.searchParams.get("q") ?? "";
    const patients = await searchPatients(db, facilityId, query, 10);
    return NextResponse.json({ patients });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
