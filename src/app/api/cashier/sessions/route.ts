import { NextRequest, NextResponse } from "next/server";

import {
  openCashierSession,
  type OpenCashierSessionInput,
} from "@/server/commands/billing";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getOpenCashierSession, listCashierSessions } from "@/server/queries/billing";

import { CASHIER_ROLES, handleCashierCommand } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { facilityId, staff } = await requireApiFacility(CASHIER_ROLES);
    const [current, recent] = await Promise.all([
      getOpenCashierSession(db, facilityId, staff.user.id),
      listCashierSessions(db, facilityId, 10),
    ]);
    return NextResponse.json({ current, recent });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  return handleCashierCommand<OpenCashierSessionInput, unknown>(
    request,
    "Invalid session",
    openCashierSession,
  );
}
