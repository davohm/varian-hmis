import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { registerPatient } from "@/server/commands/patients";

export async function POST(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(["receptionist", "admin"]);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid patient details" }, { status: 400 });
    }

    const result = await registerPatient({
      ...(body as Parameters<typeof registerPatient>[0]),
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid patient details", issues: error.issues },
        { status: 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
