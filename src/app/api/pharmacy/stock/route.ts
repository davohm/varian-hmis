import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { listStock, listStores } from "@/server/queries/pharmacy";

import { PHARMACY_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(PHARMACY_ROLES);
    const searchParams = request.nextUrl.searchParams;
    const storeId = searchParams.get("storeId") ?? undefined;
    const search = searchParams.get("q") ?? "";
    const [stock, stores] = await Promise.all([
      listStock(db, facilityId, { storeId, search }),
      listStores(db, facilityId),
    ]);
    return NextResponse.json({ stock, stores });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
