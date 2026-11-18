import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { searchIcd10 } from "@/server/queries/clinical";

import { DOCTOR_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireApiFacility(DOCTOR_ROLES);
    const query = request.nextUrl.searchParams.get("q") ?? "";
    const codes = await searchIcd10(db, query, 12);
    return NextResponse.json({ codes });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
