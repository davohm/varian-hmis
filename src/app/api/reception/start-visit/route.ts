import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { startVisit } from "@/server/commands/encounters";
import { db } from "@/server/db/client";
import { branches } from "@/server/db/schema";

export async function POST(request: NextRequest) {
  try {
    const { facilityId, branchId, staff } = await requireApiFacility(["receptionist", "admin"]);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid visit details" }, { status: 400 });
    }

    let resolvedBranchId = branchId;
    if (!resolvedBranchId) {
      const rows = await db
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.facilityId, facilityId))
        .limit(1);
      resolvedBranchId = rows[0]?.id ?? null;
    }
    if (!resolvedBranchId) {
      return NextResponse.json({ error: "No branch is configured for this facility" }, { status: 400 });
    }

    const result = await startVisit({
      ...(body as Parameters<typeof startVisit>[0]),
      facilityId,
      branchId: resolvedBranchId,
      actor: actorFromRequest(request, staff.user.id),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid visit details", issues: error.issues },
        { status: 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
