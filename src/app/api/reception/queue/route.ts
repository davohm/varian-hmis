import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { queuePatient } from "@/server/commands/queue";

export async function POST(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(["receptionist", "admin"]);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid queue request" }, { status: 400 });
    }

    const result = await queuePatient({
      ...(body as Parameters<typeof queuePatient>[0]),
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid queue request", issues: error.issues },
        { status: 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
