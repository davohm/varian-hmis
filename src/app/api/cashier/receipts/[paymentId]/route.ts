import { NextRequest, NextResponse } from "next/server";

import { renderReceiptText } from "@/lib/billing";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getReceipt } from "@/server/queries/billing";

import { CASHIER_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  try {
    const { facilityId } = await requireApiFacility(CASHIER_ROLES);
    const { paymentId } = await params;
    const receipt = await getReceipt(db, facilityId, paymentId);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
    }
    return NextResponse.json({ receipt, text: renderReceiptText(receipt) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
