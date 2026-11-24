import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { departments, rooms } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { facilityId } = await requireApiFacility(["triage_nurse", "admin", "super_admin"]);
    const available = await db
      .select({
        id: rooms.id,
        name: rooms.name,
        department: departments.name,
      })
      .from(rooms)
      .innerJoin(
        departments,
        and(eq(departments.id, rooms.departmentId), eq(departments.facilityId, rooms.facilityId)),
      )
      .where(and(eq(rooms.facilityId, facilityId), eq(rooms.active, true)))
      .orderBy(asc(rooms.name));

    return NextResponse.json({ rooms: available });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
