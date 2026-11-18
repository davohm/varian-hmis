import { NextResponse } from "next/server";

import { getSessionContext } from "@/server/auth/guards";

export async function GET() {
  const context = await getSessionContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(context);
}
