import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { getInvoiceDetail } from "@/server/queries/billing";

import { CASHIER_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  try {
    const { facilityId } = await requireApiFacility(CASHIER_ROLES);
    const { invoiceId } = await params;
    const detail = await getInvoiceDetail(db, facilityId, invoiceId);
    if (!detail) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
