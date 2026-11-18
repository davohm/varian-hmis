import { NextRequest, NextResponse } from "next/server";

import { db } from "@/server/db/client";
import { APP_MODE } from "@/server/env";
import { authorizeSyncToken, SyncAuthError } from "@/server/sync/auth";
import { readPullRows } from "@/server/sync/pull";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    if (APP_MODE !== "cloud") {
      return NextResponse.json({ error: "Catalogs are served only by the cloud" }, { status: 403 });
    }

    const params = request.nextUrl.searchParams;
    const deviceKey = request.headers.get("x-device-key") ?? params.get("deviceKey") ?? "";
    if (!deviceKey.trim()) {
      return NextResponse.json({ error: "x-device-key is required" }, { status: 400 });
    }

    const rawSince = params.get("since");
    const since = rawSince ? new Date(rawSince) : new Date(0);
    if (Number.isNaN(since.getTime())) {
      return NextResponse.json({ error: "since must be an ISO timestamp" }, { status: 400 });
    }

    const principal = await authorizeSyncToken(
      db,
      request.headers.get("authorization"),
      deviceKey,
    );

    const rows = await readPullRows(db, principal.facilityId, since);
    return NextResponse.json({ rows, pulledAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof SyncAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[sync/pull] failed", error);
    return NextResponse.json({ error: "Sync pull failed" }, { status: 500 });
  }
}
