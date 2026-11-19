import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import type { Role } from "@/server/db/schema";

type FinanceCommand = (input: Record<string, unknown>) => Promise<unknown>;

const commandRequestSchema = z.object({
  command: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});

/**
 * One guarded mutation endpoint per ERP workspace. Each command still owns its
 * input validation, idempotency key and facility scope.
 */
export async function handleErpCommand(
  request: NextRequest,
  roles: Role[],
  commands: Record<string, FinanceCommand>,
  message: string,
): Promise<NextResponse> {
  try {
    const { facilityId, staff } = await requireApiFacility(roles);
    const body = commandRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: message, issues: body.error.issues },
        { status: 400 },
      );
    }

    const run = commands[body.data.command];
    if (!run) {
      return NextResponse.json({ error: "Unknown command" }, { status: 400 });
    }

    const { facilityId: _facility, actor: _actor, ...cleanInput } = body.data.input;
    void _facility;
    void _actor;

    const result = await run({
      ...cleanInput,
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: message, issues: error.issues }, { status: 400 });
    }
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
