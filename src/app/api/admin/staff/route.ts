import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest } from "@/server/auth/api-context";
import { changeStaffRole } from "@/server/commands/admin";
import { db } from "@/server/db/client";
import { listAdminStaff } from "@/server/queries/admin";

import { requireAdminSection } from "../_shared";

export const dynamic = "force-dynamic";

const roleChangeSchema = z.object({
  userId: z.string().min(1),
  role: z.string().min(1),
  idempotencyKey: z.uuid(),
});

export async function GET() {
  try {
    const { facilityId } = await requireAdminSection("staff");
    return NextResponse.json({ staff: await listAdminStaff(db, facilityId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireAdminSection("staff");
    const parsed = roleChangeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid role change", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await changeStaffRole({
      ...parsed.data,
      facilityId,
      actor: actorFromRequest(request, staff.user.id),
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid role change", issues: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Staff scope not found") {
      return NextResponse.json({ error: "Staff scope not found" }, { status: 404 });
    }
    return apiErrorResponse(error);
  }
}
