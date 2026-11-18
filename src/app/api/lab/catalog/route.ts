import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { listLabTests } from "@/server/queries/clinical";

import { LAB_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { facilityId } = await requireApiFacility(LAB_ROLES);
    const tests = await listLabTests(db, facilityId);
    return NextResponse.json({ tests });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
