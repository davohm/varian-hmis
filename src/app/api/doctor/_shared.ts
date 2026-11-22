import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import type { Role } from "@/server/db/schema";

export const DOCTOR_ROLES: Role[] = ["doctor", "admin", "super_admin"];

/**
 * Every doctor write is a server-side command: the route only injects the
 * facility and the authenticated actor, then lets the command validate.
 */
export async function handleDoctorCommand<I, R>(
  request: NextRequest,
  message: string,
  run: (input: I) => Promise<R>,
): Promise<NextResponse> {
  try {
    const { facilityId, staff } = await requireApiFacility(DOCTOR_ROLES);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const input = {
      ...(body as Record<string, unknown>),
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    } as I;
    const result = await run(input);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: message, issues: error.issues }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
