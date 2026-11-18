import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import type { Role } from "@/server/db/schema";

export const PHARMACY_ROLES: Role[] = ["pharmacist", "admin"];

/**
 * Every pharmacy write is a server-side command: the route only injects the
 * facility and the authenticated actor, then lets the command validate.
 */
export async function handlePharmacyCommand<I, R>(
  request: NextRequest,
  message: string,
  run: (input: I) => Promise<R>,
): Promise<NextResponse> {
  try {
    const { facilityId, staff } = await requireApiFacility(PHARMACY_ROLES);
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
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    // Stock conflicts (expired batch, insufficient quantity, closed
    // prescription) are expected domain outcomes, not server faults.
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
