import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/app/api/admin/_shared";
import { apiErrorResponse } from "@/server/auth/api-error";
import { db } from "@/server/db/client";
import {
  getSyncStatus,
  listFailedOutboxIds,
  listFailedRows,
  retryOutboxRows,
} from "@/server/sync/outbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const retrySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    outboxIds: z.array(z.uuid()).min(1).max(100),
  }),
  z.object({ action: z.literal("retry-all") }),
]);

export async function GET() {
  try {
    const { facilityId } = await requireAdmin();
    const [status, failedRows] = await Promise.all([
      getSyncStatus(db, facilityId),
      listFailedRows(db, facilityId),
    ]);
    return NextResponse.json({ status, failedRows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { facilityId } = await requireAdmin();
    const body = retrySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid retry request", issues: body.error.issues },
        { status: 400 },
      );
    }

    const outboxIds = body.data.action === "retry"
      ? body.data.outboxIds
      : await listFailedOutboxIds(db, facilityId);
    const retried = await retryOutboxRows(db, outboxIds, facilityId);
    return NextResponse.json({ retried });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
