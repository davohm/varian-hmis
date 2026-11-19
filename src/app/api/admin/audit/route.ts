import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { listAudit } from "@/server/audit";
import { db } from "@/server/db/client";

import { requireAdminSection } from "../_shared";

export const dynamic = "force-dynamic";

const auditQuerySchema = z.object({
  userId: z.string().trim().max(128).optional(),
  action: z.string().trim().max(128).optional(),
  module: z.string().trim().max(64).optional(),
  entity: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(128).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireAdminSection("audit");
    const params = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = auditQuerySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid audit filter", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { limit, ...filters } = parsed.data;
    const events = await listAudit(db, facilityId, limit, filters);
    return NextResponse.json({ events });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
