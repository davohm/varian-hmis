import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { ADMIN_SECTIONS, type AdminSection } from "@/lib/admin-sections";
import { db } from "@/server/db/client";
import {
  adminSectionPermissions,
  branches,
  departments,
  facilities,
  items,
  labTests,
  priceLists,
  prices,
  rooms,
  services,
  staffProfiles,
  staffRoleScopes,
  stores,
  user,
} from "@/server/db/schema";

export type AdminDatabase = typeof db;

export interface FacilityOption {
  id: string;
  code: string;
  name: string;
  county: string | null;
  writeAuthority: "cloud" | "clinic";
  active: boolean;
}

export async function listAdminFacilities(
  database: AdminDatabase,
  allowedFacilityIds?: string[],
): Promise<FacilityOption[]> {
  const conditions = allowedFacilityIds?.length
    ? [inArray(facilities.id, allowedFacilityIds)]
    : [];
  return database
    .select({
      id: facilities.id,
      code: facilities.code,
      name: facilities.name,
      county: facilities.county,
      writeAuthority: facilities.writeAuthority,
      active: facilities.active,
    })
    .from(facilities)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(facilities.code));
}

export async function listBranches(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: branches.id,
      code: branches.code,
      name: branches.name,
      isMain: branches.isMain,
      active: branches.active,
    })
    .from(branches)
    .where(eq(branches.facilityId, facilityId))
    .orderBy(asc(branches.code));
}

export async function listDepartments(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: departments.id,
      branchId: departments.branchId,
      name: departments.name,
      kind: departments.kind,
      active: departments.active,
    })
    .from(departments)
    .where(eq(departments.facilityId, facilityId))
    .orderBy(asc(departments.name));
}

export async function listRooms(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: rooms.id,
      departmentId: rooms.departmentId,
      name: rooms.name,
      active: rooms.active,
    })
    .from(rooms)
    .where(eq(rooms.facilityId, facilityId))
    .orderBy(asc(rooms.name));
}

export async function listSetupStores(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: stores.id,
      branchId: stores.branchId,
      name: stores.name,
      kind: stores.kind,
      active: stores.active,
    })
    .from(stores)
    .where(eq(stores.facilityId, facilityId))
    .orderBy(asc(stores.name));
}

export interface StaffRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  staffNumber: string;
  phone: string | null;
  isActive: boolean;
  role: string;
  facilityId: string;
  branchId: string | null;
}

export async function listAdminStaff(
  database: AdminDatabase,
  facilityId: string,
): Promise<StaffRow[]> {
  return database
    .select({
      id: staffRoleScopes.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      staffNumber: staffProfiles.staffNumber,
      phone: staffProfiles.phone,
      isActive: staffProfiles.isActive,
      role: staffRoleScopes.role,
      facilityId: staffRoleScopes.facilityId,
      branchId: staffRoleScopes.branchId,
    })
    .from(staffProfiles)
    .innerJoin(user, eq(staffProfiles.userId, user.id))
    .innerJoin(
      staffRoleScopes,
      and(
        eq(staffRoleScopes.userId, staffProfiles.userId),
        eq(staffRoleScopes.facilityId, facilityId),
      ),
    )
    .orderBy(asc(staffProfiles.staffNumber), asc(staffRoleScopes.role));
}

export interface AdminAccessRow {
  userId: string;
  name: string;
  email: string;
  sections: AdminSection[];
}

export async function listAdminSectionAccess(
  database: AdminDatabase,
  facilityId: string,
): Promise<AdminAccessRow[]> {
  const [admins, grants] = await Promise.all([
    database
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
      })
      .from(staffRoleScopes)
      .innerJoin(user, eq(staffRoleScopes.userId, user.id))
      .where(
        and(eq(staffRoleScopes.facilityId, facilityId), eq(staffRoleScopes.role, "admin")),
      )
      .orderBy(asc(user.name)),
    database
      .select({ userId: adminSectionPermissions.userId, section: adminSectionPermissions.section })
      .from(adminSectionPermissions)
      .where(eq(adminSectionPermissions.facilityId, facilityId)),
  ]);

  const grantsByUser = new Map<string, AdminSection[]>();
  for (const grant of grants) {
    const list = grantsByUser.get(grant.userId) ?? [];
    list.push(grant.section);
    grantsByUser.set(grant.userId, list);
  }

  return admins.map((admin) => ({
    ...admin,
    sections: grantsByUser.get(admin.userId) ?? [...ADMIN_SECTIONS],
  }));
}

export async function listAdminItems(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: items.id,
      code: items.code,
      name: items.name,
      kind: items.kind,
      unit: items.unit,
      strength: items.strength,
      form: items.form,
      active: items.active,
      scope: sql<string>`case when ${items.facilityId} is null then 'shared' else 'facility' end`,
    })
    .from(items)
    .where(or(isNull(items.facilityId), eq(items.facilityId, facilityId)))
    .orderBy(asc(items.code));
}

export async function listAdminLabTests(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: labTests.id,
      code: labTests.code,
      name: labTests.name,
      sampleType: labTests.sampleType,
      active: labTests.active,
      scope: sql<string>`case when ${labTests.facilityId} is null then 'shared' else 'facility' end`,
    })
    .from(labTests)
    .where(or(isNull(labTests.facilityId), eq(labTests.facilityId, facilityId)))
    .orderBy(asc(labTests.code));
}

export async function listAdminServices(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: services.id,
      code: services.code,
      name: services.name,
      kind: services.kind,
      defaultPrice: services.defaultPrice,
      active: services.active,
      scope: sql<string>`case when ${services.facilityId} is null then 'shared' else 'facility' end`,
    })
    .from(services)
    .where(or(isNull(services.facilityId), eq(services.facilityId, facilityId)))
    .orderBy(asc(services.code));
}

export async function listAdminPriceLists(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: priceLists.id,
      name: priceLists.name,
      payerType: priceLists.payerType,
      active: priceLists.active,
      priceCount: sql<number>`count(${prices.id})::int`,
    })
    .from(priceLists)
    .leftJoin(prices, eq(prices.priceListId, priceLists.id))
    .where(eq(priceLists.facilityId, facilityId))
    .groupBy(priceLists.id)
    .orderBy(asc(priceLists.payerType));
}

export async function listAdminPrices(database: AdminDatabase, facilityId: string) {
  return database
    .select({
      id: prices.id,
      priceListId: prices.priceListId,
      priceListName: priceLists.name,
      targetType: sql<string>`case when ${prices.serviceId} is null then 'item' else 'service' end`,
      targetId: sql<string>`coalesce(${prices.serviceId}, ${prices.itemId})`,
      targetName: sql<string>`coalesce(${services.name}, ${items.name})`,
      amount: prices.amount,
      active: prices.active,
      voidedAt: prices.voidedAt,
    })
    .from(prices)
    .innerJoin(priceLists, eq(prices.priceListId, priceLists.id))
    .leftJoin(services, eq(prices.serviceId, services.id))
    .leftJoin(items, eq(prices.itemId, items.id))
    .where(eq(prices.facilityId, facilityId))
    .orderBy(asc(priceLists.name), asc(sql`coalesce(${services.name}, ${items.name})`))
    .limit(500);
}
