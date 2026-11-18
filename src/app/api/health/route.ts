import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/server/db/client";
import { APP_MODE, SYNC_ENABLED } from "@/server/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({
      status: "ok",
      appMode: APP_MODE,
      syncEnabled: SYNC_ENABLED,
      now: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[health] database check failed", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
