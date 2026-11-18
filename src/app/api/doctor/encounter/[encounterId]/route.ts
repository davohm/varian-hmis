import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getEncounterClinicalDetail } from "@/server/queries/clinical";

import { DOCTOR_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ encounterId: string }> },
) {
  try {
    const { facilityId } = await requireApiFacility(DOCTOR_ROLES);
    const { encounterId } = await params;
    const detail = await getEncounterClinicalDetail(db, facilityId, encounterId);
    if (!detail) {
      return NextResponse.json({ error: "Encounter not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
