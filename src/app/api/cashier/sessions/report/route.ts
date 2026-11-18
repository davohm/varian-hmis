import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getEndOfDayReport, getOpenCashierSession } from "@/server/queries/billing";

import { CASHIER_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(CASHIER_ROLES);
    let sessionId = request.nextUrl.searchParams.get("sessionId");
    if (!sessionId) {
      const current = await getOpenCashierSession(db, facilityId, staff.user.id);
      sessionId = current?.sessionId ?? null;
    }
    if (!sessionId) {
      return NextResponse.json({ error: "No cashier session to report on" }, { status: 404 });
    }
    const report = await getEndOfDayReport(db, facilityId, sessionId);
    if (!report) {
      return NextResponse.json({ error: "Cashier session not found" }, { status: 404 });
    }
    return NextResponse.json(report);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
