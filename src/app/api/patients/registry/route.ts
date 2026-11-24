import { NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { db } from "@/server/db/client";
import { ALL_ROLES } from "@/server/db/schema";
import { listPatients } from "@/server/queries/patients";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 100;

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.trunc(parsed);
  return integer > 0 ? integer : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(ALL_ROLES);
    const params = request.nextUrl.searchParams;
    const query = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
    const page = positiveInt(params.get("page"), 1);
    const pageSize = Math.min(
      positiveInt(params.get("pageSize"), DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );
    const offset = (page - 1) * pageSize;

    const { rows, total } = await listPatients(db, facilityId, query, pageSize, offset);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return NextResponse.json({
      patients: rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
