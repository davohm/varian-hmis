import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getCashierQueue } from "@/server/queries/billing";

import { CASHIER_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(CASHIER_ROLES);
    const query = request.nextUrl.searchParams.get("q") ?? "";
    const queue = await getCashierQueue(db, facilityId, query);
    return NextResponse.json({ queue });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
