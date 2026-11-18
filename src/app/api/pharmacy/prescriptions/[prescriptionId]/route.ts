import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getPrescriptionDetail } from "@/server/queries/pharmacy";

import { PHARMACY_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ prescriptionId: string }> },
) {
  try {
    const { facilityId } = await requireApiFacility(PHARMACY_ROLES);
    const { prescriptionId } = await params;
    const detail = await getPrescriptionDetail(db, facilityId, prescriptionId);
    if (!detail) {
      return NextResponse.json({ error: "Prescription not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
