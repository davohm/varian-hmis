import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ASSET_READ_ROLES, ASSET_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  addMaintenanceNote,
  approveAssetDisposal,
  approveAssetValuation,
  approveDepreciationRun,
  assignAsset,
  completeAssetDisposal,
  completeMaintenanceOrder,
  createAsset,
  createDepreciationRun,
  createMaintenanceOrder,
  postAssetValuation,
  postDepreciationRun,
  requestAssetDisposal,
  requestAssetValuation,
  startMaintenanceOrder,
} from "@/server/commands/assets";
import { db } from "@/server/db/client";
import {
  getAssetDetail,
  getAssetOverview,
  getDepreciationRun,
  listAssetCostCenters,
  listAssetDepartments,
  listAssetDisposals,
  listAssetEmployees,
  listAssetValuations,
  listAssets,
  listDepreciationRuns,
  listMaintenanceOrders,
} from "@/server/queries/assets";

import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  createAsset: (input) => createAsset(input as Parameters<typeof createAsset>[0]),
  assignAsset: (input) => assignAsset(input as Parameters<typeof assignAsset>[0]),
  createDepreciationRun: (input) =>
    createDepreciationRun(input as Parameters<typeof createDepreciationRun>[0]),
  approveDepreciationRun: (input) =>
    approveDepreciationRun(input as Parameters<typeof approveDepreciationRun>[0]),
  postDepreciationRun: (input) =>
    postDepreciationRun(input as Parameters<typeof postDepreciationRun>[0]),
  createMaintenanceOrder: (input) =>
    createMaintenanceOrder(input as Parameters<typeof createMaintenanceOrder>[0]),
  startMaintenanceOrder: (input) =>
    startMaintenanceOrder(input as Parameters<typeof startMaintenanceOrder>[0]),
  completeMaintenanceOrder: (input) =>
    completeMaintenanceOrder(input as Parameters<typeof completeMaintenanceOrder>[0]),
  addMaintenanceNote: (input) =>
    addMaintenanceNote(input as Parameters<typeof addMaintenanceNote>[0]),
  requestAssetValuation: (input) =>
    requestAssetValuation(input as Parameters<typeof requestAssetValuation>[0]),
  approveAssetValuation: (input) =>
    approveAssetValuation(input as Parameters<typeof approveAssetValuation>[0]),
  postAssetValuation: (input) =>
    postAssetValuation(input as Parameters<typeof postAssetValuation>[0]),
  requestAssetDisposal: (input) =>
    requestAssetDisposal(input as Parameters<typeof requestAssetDisposal>[0]),
  approveAssetDisposal: (input) =>
    approveAssetDisposal(input as Parameters<typeof approveAssetDisposal>[0]),
  completeAssetDisposal: (input) =>
    completeAssetDisposal(input as Parameters<typeof completeAssetDisposal>[0]),
};

export async function GET(request: NextRequest) {
  try {
    const { facilityId, staff } = await requireApiFacility(ASSET_READ_ROLES);
    const params = new URL(request.url).searchParams;
    const assetId = params.get("assetId") ?? undefined;
    const runId = params.get("runId") ?? undefined;

    const [
      overview,
      assetList,
      runs,
      orders,
      valuations,
      disposals,
      detail,
      runDetail,
      employees,
      costCenters,
      departments,
    ] = await Promise.all([
      getAssetOverview(db, facilityId),
      listAssets(db, facilityId),
      listDepreciationRuns(db, facilityId),
      listMaintenanceOrders(db, facilityId),
      listAssetValuations(db, facilityId),
      listAssetDisposals(db, facilityId),
      assetId ? getAssetDetail(db, facilityId, assetId) : Promise.resolve(null),
      runId ? getDepreciationRun(db, facilityId, runId) : Promise.resolve(null),
      listAssetEmployees(db, facilityId),
      listAssetCostCenters(db, facilityId),
      listAssetDepartments(db, facilityId),
    ]);

    return NextResponse.json({
      viewerId: staff.user.id,
      overview,
      assets: assetList,
      runs,
      orders,
      valuations,
      disposals,
      detail,
      runDetail,
      employees,
      costCenters,
      departments,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(request, ASSET_WRITE_ROLES, commands, "Invalid asset command");
}
