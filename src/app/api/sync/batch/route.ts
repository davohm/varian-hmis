import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/server/db/client";
import { APP_MODE } from "@/server/env";
import { applySyncBatch, SyncBatchError } from "@/server/sync/batch";
import { authorizeSyncToken, SyncAuthError } from "@/server/sync/auth";
import { syncBatchSchema } from "@/server/sync/types";
import {
  assertSyncSchemaVersion,
  SyncSchemaError,
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
} from "@/server/sync/version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (APP_MODE !== "cloud") {
      return NextResponse.json({ error: "Sync batches are accepted only by the cloud" }, { status: 403 });
    }

    assertSyncSchemaVersion(request.headers.get(SYNC_SCHEMA_HEADER));

    const body = syncBatchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid sync batch", issues: body.error.issues },
        { status: 400 },
      );
    }

    const principal = await authorizeSyncToken(
      db,
      request.headers.get("authorization"),
      body.data.deviceKey,
      body.data.facilityId,
    );

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
      return applySyncBatch(tx, principal.facilityId, principal.deviceKey, body.data.rows);
    });

    return NextResponse.json(result, {
      status: 201,
      headers: { [SYNC_SCHEMA_HEADER]: String(SYNC_SCHEMA_VERSION) },
    });
  } catch (error) {
    if (error instanceof SyncAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyncSchemaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError || error instanceof SyncBatchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[sync/batch] failed", error);
    return NextResponse.json({ error: "Sync batch failed" }, { status: 500 });
  }
}
