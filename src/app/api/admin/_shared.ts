import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ADMIN_COMMAND_SECTIONS, type AdminSection } from "@/lib/admin-sections";
import { apiErrorResponse } from "@/server/auth/api-error";
import { getAdminSections } from "@/server/auth/admin-access";
import { requireApiFacility, actorFromRequest } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";

export const ADMIN_ROLES = ["admin"] as const;

export async function requireAdmin() {
  return requireApiFacility([...ADMIN_ROLES]);
}

/** Admin identity plus the effective per-section grants for the active facility. */
export async function requireAdminAccess() {
  const context = await requireAdmin();
  const sections = await getAdminSections(context.staff.user.id, context.facilityId);
  return { ...context, sections };
}

export async function requireAdminSection(section: AdminSection) {
  const context = await requireAdminAccess();
  if (!context.sections.includes(section)) {
    throw new ForbiddenError("You do not have access to this administration section.");
  }
  return context;
}

type AdminCommand = (input: Record<string, unknown>) => Promise<unknown>;

const commandRequestSchema = z.object({
  command: z.string().trim().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
});

/** One guarded mutation endpoint. Every command still owns its own validation. */
export async function handleAdminCommand(
  request: NextRequest,
  commands: Record<string, AdminCommand>,
) {
  try {
    const context = await requireAdminAccess();
    const { facilityId, staff, sections } = context;
    const body = commandRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid admin command request", issues: body.error.issues },
        { status: 400 },
      );
    }

    const run = commands[body.data.command];
    const commandSection = ADMIN_COMMAND_SECTIONS[body.data.command];
    if (!run || !commandSection) {
      return NextResponse.json({ error: "Unknown admin command" }, { status: 400 });
    }
    if (!sections.includes(commandSection)) {
      throw new ForbiddenError("You do not have access to this administration section.");
    }

    const { facilityId: _ignoredFacility, actor: _ignoredActor, ...cleanInput } = body.data.input;
    void _ignoredFacility;
    void _ignoredActor;

    const result = await run({
      ...cleanInput,
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
      allowedFacilityIds: context.context?.facilities.map((facility) => facility.id) ?? [facilityId],
    });

    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid admin command input", issues: error.issues },
        { status: 400 },
      );
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
