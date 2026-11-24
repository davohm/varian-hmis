import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { callTriagePatient } from "@/server/commands/triage";

const bodySchema = z.object({
  queueEntryId: z.uuid(),
  idempotencyKey: z.uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(["triage_nurse", "admin", "super_admin"]);
    const body: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "A queue entry and idempotency key are required" }, { status: 400 });
    }

    const result = await callTriagePatient({
      ...parsed.data,
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid call details", issues: error.issues },
        { status: 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
