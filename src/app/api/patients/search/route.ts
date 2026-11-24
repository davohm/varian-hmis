import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { ALL_ROLES } from "@/server/db/schema";
import { searchPatients } from "@/server/queries/patients";

const RESULT_LIMIT = 10;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(ALL_ROLES);
    const query = (request.nextUrl.searchParams.get("q") ?? "")
      .trim()
      .slice(0, MAX_QUERY_LENGTH);

    // A single character matches most of the registry and costs a full scan.
    // The UI explains the minimum, so the API enforces it as well.
    if (query.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({
        patients: [],
        hasMore: false,
        minQueryLength: MIN_QUERY_LENGTH,
      });
    }

    const rows = await searchPatients(db, facilityId, query, RESULT_LIMIT + 1);
    return NextResponse.json({
      patients: rows.slice(0, RESULT_LIMIT),
      hasMore: rows.length > RESULT_LIMIT,
      minQueryLength: MIN_QUERY_LENGTH,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
