import { NextResponse } from "next/server";

import { ForbiddenError, UnauthorizedError } from "./guards";

export function apiErrorResponse(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  console.error(error);
  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}
