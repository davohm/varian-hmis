import { NextResponse } from "next/server";

import {
  ACTIVE_BRANCH_COOKIE,
  ACTIVE_FACILITY_COOKIE,
  authorizeStaffAccess,
  getSessionContext,
} from "@/server/auth/guards";

export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context) return NextResponse.redirect(new URL("/login", request.url));

  const facility =
    context.facilities.find((item) => item.id === context.activeFacilityId) ??
    context.facilities[0];
  if (!facility) return NextResponse.redirect(new URL("/login", request.url));

  const branch =
    facility.branches.find((item) => item.id === context.activeBranchId) ??
    facility.branches.find((item) =>
      authorizeStaffAccess(context.scopes, [], facility.id, item.id),
    ) ??
    null;

  const response = NextResponse.redirect(new URL("/", request.url));
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  };
  response.cookies.set(ACTIVE_FACILITY_COOKIE, facility.id, cookieOptions);
  if (branch) response.cookies.set(ACTIVE_BRANCH_COOKIE, branch.id, cookieOptions);
  return response;
}
