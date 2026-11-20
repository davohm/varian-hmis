import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { actorFromRequest, requireApiFacility } from "@/server/auth/api-context";
import { newIdempotencyKey } from "@/lib/uuid";
import { PATIENT_RESTRICTION_ENTITY } from "@/lib/privacy";
import { logChartAccess } from "@/server/commands/privacy";
import { db } from "@/server/db/client";
import { encounters, retentionPolicies } from "@/server/db/schema";
import { getEncounterBill } from "@/server/queries/billing";

import { CASHIER_ROLES } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ encounterId: string }> },
) {
  try {
    const { facilityId, staff } = await requireApiFacility(CASHIER_ROLES);
    const { encounterId } = await params;
    const reason = request.nextUrl.searchParams.get("reason")?.trim() || null;

    const encounterRows = await db
      .select({ patientId: encounters.patientId })
      .from(encounters)
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, facilityId)))
      .limit(1);
    const encounter = encounterRows[0];
    if (!encounter) {
      return NextResponse.json({ error: "Visit not found" }, { status: 404 });
    }

    const restrictedRows = await db
      .select({ id: retentionPolicies.id })
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.facilityId, facilityId),
          eq(retentionPolicies.entity, PATIENT_RESTRICTION_ENTITY),
          eq(retentionPolicies.triggerEvent, encounter.patientId),
          eq(retentionPolicies.legalHold, true),
        ),
      )
      .limit(1);
    if (restrictedRows[0]) {
      if (!reason) {
        return NextResponse.json(
          { error: "A reason is required to access this restricted patient chart", code: "chart_access_reason_required" },
          { status: 403 },
        );
      }
      await logChartAccess({
        facilityId,
        idempotencyKey: newIdempotencyKey(),
        actor: actorFromRequest(request, staff.user.id),
        patientId: encounter.patientId,
        accessType: "cashier_encounter",
        reason,
      });
    }

    const bill = await getEncounterBill(db, facilityId, encounterId);
    if (!bill) {
      return NextResponse.json({ error: "Visit not found" }, { status: 404 });
    }
    return NextResponse.json(bill);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
