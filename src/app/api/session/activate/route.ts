import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ACTIVE_BRANCH_COOKIE,
  ACTIVE_FACILITY_COOKIE,
  authorizeStaffAccess,
  getSessionContext,
} from "@/server/auth/guards";

const schema = z.object({
  facilityId: z.uuid(),
  branchId: z.uuid().nullable().optional(),
});

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid facility selection" }, { status: 400 });
  }

  const { facilityId, branchId = null } = parsed.data;
  const facility = context.facilities.find((item) => item.id === facilityId);
  if (!facility) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (branchId && !facility.branches.some((branch) => branch.id === branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!authorizeStaffAccess(context.scopes, [], facilityId, branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true, facilityId, branchId });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  };
  response.cookies.set(ACTIVE_FACILITY_COOKIE, facilityId, cookieOptions);
  if (branchId) {
    response.cookies.set(ACTIVE_BRANCH_COOKIE, branchId, cookieOptions);
  } else {
    response.cookies.delete(ACTIVE_BRANCH_COOKIE);
  }
  return response;
}
