import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/server/auth/api-error";
import { db } from "@/server/db/client";
import {
  listAdminFacilities,
  listAdminItems,
  listAdminLabTests,
  listAdminPriceLists,
  listAdminPrices,
  listAdminSectionAccess,
  listAdminServices,
  listAdminStaff,
  listBranches,
  listDepartments,
  listRooms,
  listSetupStores,
} from "@/server/queries/admin";

import { requireAdminAccess } from "../_shared";

export const dynamic = "force-dynamic";

async function sectionData<T>(allowed: boolean, load: () => Promise<T[]>): Promise<T[]> {
  return allowed ? load() : [];
}

export async function GET() {
  try {
    const access = await requireAdminAccess();
    const { facilityId, sections } = access;
    const allowedFacilityIds = access.context?.facilities.map((facility) => facility.id) ?? [facilityId];
    const can = (section: (typeof sections)[number]) => sections.includes(section);

    const [
      facilities,
      branches,
      departments,
      rooms,
      stores,
      staff,
      adminAccess,
      items,
      labTests,
      services,
      priceLists,
      prices,
    ] = await Promise.all([
      listAdminFacilities(db, allowedFacilityIds),
      sectionData(can("setup"), () => listBranches(db, facilityId)),
      sectionData(can("setup"), () => listDepartments(db, facilityId)),
      sectionData(can("setup"), () => listRooms(db, facilityId)),
      sectionData(can("setup"), () => listSetupStores(db, facilityId)),
      sectionData(can("staff"), () => listAdminStaff(db, facilityId)),
      sectionData(can("staff"), () => listAdminSectionAccess(db, facilityId)),
      sectionData(can("catalogs"), () => listAdminItems(db, facilityId)),
      sectionData(can("catalogs"), () => listAdminLabTests(db, facilityId)),
      sectionData(can("catalogs"), () => listAdminServices(db, facilityId)),
      sectionData(can("prices"), () => listAdminPriceLists(db, facilityId)),
      sectionData(can("prices"), () => listAdminPrices(db, facilityId)),
    ]);

    return NextResponse.json({
      facilityId,
      sections,
      facilities,
      setup: { branches, departments, rooms, stores },
      staff,
      adminAccess,
      catalogs: { items, labTests, services },
      priceLists,
      prices,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
