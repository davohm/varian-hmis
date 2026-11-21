import { randomBytes, randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSection } from "@/app/api/admin/_shared";
import { actorFromRequest } from "@/server/auth/api-context";
import {
  rotateFacilitySyncToken,
  revokeFacilitySyncToken,
} from "@/server/commands/admin";
import { apiErrorResponse } from "@/server/auth/api-error";
import { db } from "@/server/db/client";
import {
  getSyncStatus,
  listFailedOutboxIds,
  listFailedRows,
  retryOutboxRows,
} from "@/server/sync/outbox";
import { hashSyncToken } from "@/server/sync/auth";
import {
  isOverridableTable,
  listAdminOverrides,
  listOverrideTargets,
  OVERRIDE_FIELDS,
} from "@/server/sync/overrides";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const retrySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    outboxIds: z.array(z.uuid()).min(1).max(100),
  }),
  z.object({ action: z.literal("retry-all") }),
  z.object({
    action: z.literal("rotate-token"),
    deviceKey: z.string().trim().min(1).max(128),
    expiresAt: z.iso.datetime().optional(),
  }),
  z.object({
    action: z.literal("revoke-token"),
    deviceKey: z.string().trim().min(1).max(128),
  }),
]);

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireAdminSection("sync");
    const table = request.nextUrl.searchParams.get("table");
    const [status, failedRows, overrides, targets] = await Promise.all([
      getSyncStatus(db, facilityId),
      listFailedRows(db, facilityId),
      listAdminOverrides(db, facilityId),
      table && isOverridableTable(table)
        ? listOverrideTargets(db, facilityId, table)
        : Promise.resolve([]),
    ]);
    return NextResponse.json({
      facilityId,
      status,
      failedRows,
      overrides,
      targets,
      overrideFields: OVERRIDE_FIELDS,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireAdminSection("sync");
    const { facilityId } = context;
    const body = retrySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid sync request", issues: body.error.issues },
        { status: 400 },
      );
    }

    const data = body.data;
    if (data.action === "rotate-token") {
      const token = randomBytes(32).toString("base64url");
      const result = await rotateFacilitySyncToken({
        facilityId,
        idempotencyKey: randomUUID(),
        deviceKey: data.deviceKey,
        tokenHash: hashSyncToken(token),
        expiresAt: data.expiresAt,
        actor: actorFromRequest(request, context.staff.user.id),
      });
      return NextResponse.json({ ...result, token });
    }
    if (data.action === "revoke-token") {
      const result = await revokeFacilitySyncToken({
        facilityId,
        idempotencyKey: randomUUID(),
        deviceKey: data.deviceKey,
        actor: actorFromRequest(request, context.staff.user.id),
      });
      return NextResponse.json(result);
    }

    const outboxIds = data.action === "retry"
      ? data.outboxIds
      : await listFailedOutboxIds(db, facilityId);
    const retried = await retryOutboxRows(db, outboxIds, facilityId);
    return NextResponse.json({ retried });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
