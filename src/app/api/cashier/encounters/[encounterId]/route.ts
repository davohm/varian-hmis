import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getEncounterBill } from "@/server/queries/billing";

import { CASHIER_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ encounterId: string }> },
) {
  try {
    const { facilityId } = await requireApiFacility(CASHIER_ROLES);
    const { encounterId } = await params;
    const bill = await getEncounterBill(db, facilityId, encounterId);
    if (!bill) {
      return NextResponse.json({ error: "Visit not found" }, { status: 404 });
    }
    return NextResponse.json(bill);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
