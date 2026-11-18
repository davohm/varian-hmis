import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { db } from "@/server/db/client";
import {
  listAdminFacilities,
  listAdminItems,
  listAdminLabTests,
  listAdminPriceLists,
  listAdminPrices,
  listAdminServices,
  listAdminStaff,
  listBranches,
  listDepartments,
  listRooms,
  listSetupStores,
} from "@/server/queries/admin";

import { requireAdmin } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { context, facilityId } = await requireAdmin();
    const allowedFacilityIds = context?.facilities.map((facility) => facility.id) ?? [facilityId];

    const [facilities, branches, departments, rooms, stores, staff, items, labTests, services, priceLists, prices] =
      await Promise.all([
        listAdminFacilities(db, allowedFacilityIds),
        listBranches(db, facilityId),
        listDepartments(db, facilityId),
        listRooms(db, facilityId),
        listSetupStores(db, facilityId),
        listAdminStaff(db, facilityId),
        listAdminItems(db, facilityId),
        listAdminLabTests(db, facilityId),
        listAdminServices(db, facilityId),
        listAdminPriceLists(db, facilityId),
        listAdminPrices(db, facilityId),
      ]);

    return NextResponse.json({
      facilityId,
      facilities,
      setup: { branches, departments, rooms, stores },
      staff,
      catalogs: { items, labTests, services },
      priceLists,
      prices,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
