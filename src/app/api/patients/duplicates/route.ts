import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { ALL_ROLES } from "@/server/db/schema";
import { findPatientDuplicates } from "@/server/queries/patients";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(ALL_ROLES);
    const params = request.nextUrl.searchParams;
    const duplicates = await findPatientDuplicates(db, facilityId, {
      phone: params.get("phone"),
      dob: params.get("dob"),
      nationalId: params.get("nationalId"),
    });
    return NextResponse.json({ duplicates });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
