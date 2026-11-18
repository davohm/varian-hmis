import { NextRequest, NextResponse } from "next/server";

import { LAB_WORKLIST_FILTERS, type LabWorklistFilter } from "@/lib/lab";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getLabWorklist } from "@/server/queries/lab";

import { LAB_ROLES } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(LAB_ROLES);
    const requested = request.nextUrl.searchParams.get("filter") ?? "pending";
    const filter = (LAB_WORKLIST_FILTERS as readonly string[]).includes(requested)
      ? (requested as LabWorklistFilter)
      : "pending";
    const query = request.nextUrl.searchParams.get("q") ?? "";
    const orders = await getLabWorklist(db, facilityId, filter, query);
    return NextResponse.json({ orders });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
