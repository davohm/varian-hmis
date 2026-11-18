import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/server/auth/api-error";
import { getSessionContext, requireApiStaff } from "@/server/auth/guards";
import { recordAudit } from "@/server/audit";
import { db } from "@/server/db/client";
import {
  ALL_ROLES,
  staffProfiles,
  staffRoleScopes,
  user,
  type Role,
} from "@/server/db/schema";

const roleSchema = z.string().refine((value): value is Role => ALL_ROLES.includes(value as Role));

const roleChangeSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
});

export async function GET() {
  try {
    const context = await getSessionContext();
    const facilityId = context?.activeFacilityId ?? null;
    await requireApiStaff(["admin"], facilityId, context?.activeBranchId ?? null);

    const rows = await db
      .select({
        staffProfileId: staffProfiles.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        staffNumber: staffProfiles.staffNumber,
        isActive: staffProfiles.isActive,
        role: staffRoleScopes.role,
      })
      .from(staffProfiles)
      .innerJoin(user, eq(staffProfiles.userId, user.id))
      .innerJoin(
        staffRoleScopes,
        and(
          eq(staffRoleScopes.userId, staffProfiles.userId),
          eq(staffRoleScopes.facilityId, facilityId!),
        ),
      )
      .orderBy(asc(staffProfiles.staffNumber));

    return NextResponse.json({ staff: rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getSessionContext();
    const facilityId = context?.activeFacilityId ?? null;
    const staff = await requireApiStaff(
      ["admin"],
      facilityId,
      context?.activeBranchId ?? null,
    );

    const parsed = roleChangeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid role change" }, { status: 400 });
    }

    const { userId, role } = parsed.data;
    if (!facilityId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ role: staffRoleScopes.role })
        .from(staffRoleScopes)
        .where(
          and(eq(staffRoleScopes.userId, userId), eq(staffRoleScopes.facilityId, facilityId)),
        )
        .limit(1);

      const previousRole = existing[0]?.role;
      if (!previousRole) throw new Error("Staff scope not found");

      await tx.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, userId));
      await tx
        .update(staffRoleScopes)
        .set({ role })
        .where(
          and(eq(staffRoleScopes.userId, userId), eq(staffRoleScopes.facilityId, facilityId)),
        );

      await recordAudit(tx, {
        facilityId,
        userId: staff.user.id,
        action: "auth.role_change",
        module: "admin",
        entity: "staff_role_scopes",
        entityId: userId,
        details: { from: previousRole, to: role },
      });
    });

    return NextResponse.json({ ok: true, userId, role });
  } catch (error) {
    if (error instanceof Error && error.message === "Staff scope not found") {
      return NextResponse.json({ error: "Staff scope not found" }, { status: 404 });
    }
    return apiErrorResponse(error);
  }
}
