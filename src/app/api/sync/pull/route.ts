import { NextRequest, NextResponse } from "next/server";

import { db } from "@/server/db/client";
import { APP_MODE } from "@/server/env";
import { authorizeSyncToken, SyncAuthError } from "@/server/sync/auth";
import { readPullRows } from "@/server/sync/pull";
import {
  overrideCursorSchema,
  pullCursorsSchema,
  type OverrideCursor,
  type PullCursorMap,
} from "@/server/sync/types";
import {
  assertSyncSchemaVersion,
  SyncSchemaError,
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
} from "@/server/sync/version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    if (APP_MODE !== "cloud") {
      return NextResponse.json({ error: "Catalogs are served only by the cloud" }, { status: 403 });
    }

    assertSyncSchemaVersion(request.headers.get(SYNC_SCHEMA_HEADER));

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

    let cursors: PullCursorMap = {};
    const rawCursors = params.get("cursors");
    if (rawCursors) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawCursors);
      } catch {
        return NextResponse.json({ error: "cursors must be valid JSON" }, { status: 400 });
      }
      const parsedCursors = pullCursorsSchema.safeParse(decoded);
      if (!parsedCursors.success) {
        return NextResponse.json({ error: "cursors contain an unknown table or invalid value" }, { status: 400 });
      }
      cursors = parsedCursors.data;
    }

    let overrideCursor: OverrideCursor | undefined;
    const rawOverrideCursor = params.get("overridesCursor");
    if (rawOverrideCursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawOverrideCursor);
      } catch {
        return NextResponse.json({ error: "overridesCursor must be valid JSON" }, { status: 400 });
      }
      const parsedOverride = overrideCursorSchema.safeParse(decoded);
      if (!parsedOverride.success) {
        return NextResponse.json({ error: "overridesCursor is invalid" }, { status: 400 });
      }
      overrideCursor = parsedOverride.data;
    }

    const principal = await authorizeSyncToken(
      db,
      request.headers.get("authorization"),
      deviceKey,
    );

    const page = await readPullRows(db, principal.facilityId, cursors, undefined, overrideCursor);
    return NextResponse.json({
      rows: page.rows,
      cursors: page.cursors,
      overrides: page.overrides,
      overrideCursor: page.overrideCursor,
      pulledAt: new Date().toISOString(),
    }, { headers: { [SYNC_SCHEMA_HEADER]: String(SYNC_SCHEMA_VERSION) } });
  } catch (error) {
    if (error instanceof SyncAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyncSchemaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[sync/pull] failed", error);
    return NextResponse.json({ error: "Sync pull failed" }, { status: 500 });
  }
}
