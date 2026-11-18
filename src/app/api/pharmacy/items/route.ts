import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { searchStockItems } from "@/server/queries/pharmacy";

import { PHARMACY_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(PHARMACY_ROLES);
    const query = request.nextUrl.searchParams.get("q") ?? "";
    const items = await searchStockItems(db, facilityId, query);
    return NextResponse.json({ items });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
