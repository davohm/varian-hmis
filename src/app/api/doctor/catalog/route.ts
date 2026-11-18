import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { listDrugs, listLabTests } from "@/server/queries/clinical";

import { DOCTOR_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { facilityId } = await requireApiFacility(DOCTOR_ROLES);
    const [labTests, drugs] = await Promise.all([
      listLabTests(db, facilityId),
      listDrugs(db, facilityId),
    ]);
    return NextResponse.json({ labTests, drugs });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
