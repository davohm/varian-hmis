import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { listAudit } from "../src/server/audit";
import {
  changeStaffRole,
  createBranch,
  createDepartment,
  createFacility,
  createItem,
  createLabTest,
  createPriceList,
  createRoom,
  createService,
  createStaff,
  createStore,
  importIcd10,
  removePrice,
  setBranchActive,
  setDepartmentActive,
  setFacilityActive,
  setItemActive,
  setLabTestActive,
  setPriceListActive,
  setRoomActive,
  setServiceActive,
  setStaffActive,
  setStoreActive,
  updateBranch,
  updateFacility,
  updatePriceList,
  upsertPrice,
} from "../src/server/commands/admin";
import {
  auditLog,
  branches,
  departments,
  facilities,
  icd10Codes,
  items,
  labTests,
  priceLists,
  prices,
  services,
  staffProfiles,
  staffRoleScopes,
  user,
} from "../src/server/db/schema";
import {
  cleanupTestFacility,
  createTestDatabase,
  deleteTestActor,
  insertTestActor,
  insertTestBranch,
  insertTestFacility,
  type TestDatabase,
} from "./helpers";

let ctx: TestDatabase;

beforeAll(() => {
  ctx = createTestDatabase();
});

afterAll(async () => {
  await ctx.pool.end();
});

interface AdminScope {
  facility: { id: string; code: string };
  branchId: string;
  actorId: string;
  extraFacilityIds: string[];
  sharedItemIds: string[];
  sharedLabTestIds: string[];
  sharedServiceIds: string[];
  icdCodes: string[];
}

function token(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

interface AdminInputBase {
  facilityId: string;
  idempotencyKey: string;
  actor: {
    userId: string;
    deviceId: string;
    ip: string;
  };
}

function input<const T extends Record<string, unknown>>(
  scope: AdminScope,
  overrides: T = {} as T,
): AdminInputBase & DeepMutable<T> {
  return {
    facilityId: scope.facility.id,
    idempotencyKey: newIdempotencyKey(),
    actor: {
      userId: scope.actorId,
      deviceId: "vitest-admin",
      ip: "127.0.0.1",
    },
    ...overrides,
  } as AdminInputBase & DeepMutable<T>;
}

async function withFacility<T>(run: (scope: AdminScope) => Promise<T>): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const actorId = await insertTestActor(ctx.db);
  const extraFacilityIds: string[] = [];
  const sharedItemIds: string[] = [];
  const sharedLabTestIds: string[] = [];
  const sharedServiceIds: string[] = [];
  const icdCodes: string[] = [];

  try {
    return await run({
      facility,
      branchId,
      actorId,
      extraFacilityIds,
      sharedItemIds,
      sharedLabTestIds,
      sharedServiceIds,
      icdCodes,
    });
  } finally {
    for (const facilityId of extraFacilityIds) {
      await cleanupTestFacility(ctx.db, facilityId);
    }
    await cleanupTestFacility(ctx.db, facility.id);
    await deleteTestActor(ctx.db, actorId);

    if (sharedServiceIds.length) {
      await ctx.db.delete(services).where(inArray(services.id, sharedServiceIds));
    }
    if (sharedItemIds.length) {
      await ctx.db.delete(items).where(inArray(items.id, sharedItemIds));
    }
    if (sharedLabTestIds.length) {
      await ctx.db.delete(labTests).where(inArray(labTests.id, sharedLabTestIds));
    }
    if (icdCodes.length) {
      await ctx.db.delete(icd10Codes).where(inArray(icd10Codes.code, icdCodes));
    }
  }
}

describe("administration commands", () => {
  it("creates facilities idempotently, grants the creator admin scope and audits the write", async () => {
    await withFacility(async (scope) => {
      const code = token("ADDF");
      const idempotencyKey = newIdempotencyKey();
      const payload = {
        ...input(scope, { code, name: "Added Facility" }),
        idempotencyKey,
      };

      const created = await createFacility(payload, { database: ctx.db });
      scope.extraFacilityIds.push(created.facilityId);

      const replayed = await createFacility(
        { ...payload, name: "Changed name that must be ignored" },
        { database: ctx.db },
      );
      expect(replayed).toEqual(created);

      const rows = await ctx.db.select().from(facilities).where(eq(facilities.code, code));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: created.facilityId,
        code,
        active: true,
        writeAuthority: "cloud",
      });

      const grants = await ctx.db
        .select()
        .from(staffRoleScopes)
        .where(eq(staffRoleScopes.facilityId, created.facilityId));
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        userId: scope.actorId,
        role: "admin",
        branchId: null,
      });

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.facilityId, scope.facility.id),
            eq(auditLog.entityId, created.facilityId),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "admin.facility.create",
        module: "admin",
        userId: scope.actorId,
      });

      await expect(
        updateFacility(
          input(scope, {
            id: created.facilityId,
            allowedFacilityIds: [scope.facility.id],
            name: "Outside scope",
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("outside your administration scope");

      await expect(
        setFacilityActive(
          input(scope, {
            id: scope.facility.id,
            active: false,
            allowedFacilityIds: [scope.facility.id],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("cannot deactivate the active facility");

      const deactivated = await setFacilityActive(
        input(scope, {
          id: created.facilityId,
          active: false,
          allowedFacilityIds: [scope.facility.id, created.facilityId],
        }),
        { database: ctx.db },
      );
      expect(deactivated).toEqual({ facilityId: created.facilityId, active: false });
    });
  });

  it("keeps one main branch and unique nested tenancy rows", async () => {
    await withFacility(async (scope) => {
      const main = await ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.facilityId, scope.facility.id), eq(branches.isMain, true)));
      expect(main).toHaveLength(1);

      const branchCode = token("BR");
      const branch = await createBranch(
        input(scope, { code: branchCode, name: "Second Branch" }),
        { database: ctx.db },
      );
      await expect(
        createBranch(input(scope, { code: branchCode, name: "Duplicate Branch" }), {
          database: ctx.db,
        }),
      ).rejects.toThrow("Branch code already exists in this facility");

      await updateBranch(input(scope, { id: branch.branchId, isMain: true }), {
        database: ctx.db,
      });
      const branchRows = await ctx.db
        .select()
        .from(branches)
        .where(eq(branches.facilityId, scope.facility.id));
      expect(branchRows.filter((row) => row.isMain)).toHaveLength(1);
      expect(branchRows.find((row) => row.id === branch.branchId)?.isMain).toBe(true);

      await expect(
        setBranchActive(input(scope, { id: branch.branchId, active: false }), {
          database: ctx.db,
        }),
      ).rejects.toThrow("main branch cannot be deactivated");

      const department = await createDepartment(
        input(scope, {
          branchId: main[0].id,
          name: "Outpatient",
          kind: "opd",
        }),
        { database: ctx.db },
      );
      await expect(
        createDepartment(
          input(scope, { branchId: main[0].id, name: "Outpatient", kind: "opd" }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Department already exists in this branch");

      const room = await createRoom(
        input(scope, { departmentId: department.departmentId, name: "Consultation 1" }),
        { database: ctx.db },
      );
      await expect(
        createRoom(
          input(scope, { departmentId: department.departmentId, name: "Consultation 1" }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Room already exists in this department");

      const store = await createStore(
        input(scope, { branchId: main[0].id, name: "Dispensary", kind: "pharmacy" }),
        { database: ctx.db },
      );
      await expect(
        createStore(
          input(scope, { branchId: main[0].id, name: "Dispensary", kind: "pharmacy" }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Store already exists in this branch");

      expect(
        await setDepartmentActive(
          input(scope, { id: department.departmentId, active: false }),
          { database: ctx.db },
        ),
      ).toMatchObject({ active: false });
      expect(
        await setRoomActive(input(scope, { id: room.roomId, active: false }), {
          database: ctx.db,
        }),
      ).toMatchObject({ active: false });
      expect(
        await setStoreActive(input(scope, { id: store.storeId, active: false }), {
          database: ctx.db,
        }),
      ).toMatchObject({ active: false });
    });
  });

  it("rejects tenancy rows and staff scopes that cross facilities", async () => {
    await withFacility(async (scope) => {
      const other = await insertTestFacility(ctx.db);
      scope.extraFacilityIds.push(other.id);
      const otherBranchId = await insertTestBranch(ctx.db, other.id);
      const otherDepartmentId = newId();
      await ctx.db.insert(departments).values({
        id: otherDepartmentId,
        facilityId: other.id,
        branchId: otherBranchId,
        name: "Other Department",
        kind: "opd",
        createdBy: "vitest",
      });

      await expect(
        createDepartment(
          input(scope, { branchId: otherBranchId, name: "Crossed", kind: "opd" }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Branch not found in this facility");

      await expect(
        createRoom(
          input(scope, { departmentId: otherDepartmentId, name: "Crossed Room" }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Department not found in this facility");

      await expect(
        createStore(
          input(scope, { branchId: otherBranchId, name: "Crossed Store", kind: "main" }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Branch not found in this facility");

      const staffFields = {
        name: "Cross Scope Staff",
        email: `cross-${token("S").toLowerCase()}@fam.test`,
        password: "temporary-password-123",
        staffNumber: token("XS"),
      };

      await expect(
        createStaff(
          input(scope, {
            ...staffFields,
            allowedFacilityIds: [scope.facility.id],
            scopes: [{ role: "doctor", facilityId: other.id, branchId: null }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("outside your administration scope");

      await expect(
        createStaff(
          input(scope, {
            ...staffFields,
            scopes: [{ role: "doctor", facilityId: scope.facility.id, branchId: otherBranchId }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Role scope branch does not belong to its facility");

      await expect(
        createStaff(
          input(scope, {
            ...staffFields,
            scopes: [{ role: "doctor", facilityId: newId(), branchId: null }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Role scope references an unknown facility");
    });
  });

  it("creates deduplicated staff scopes, changes roles and deactivates safely", async () => {
    await withFacility(async (scope) => {
      const email = `staff-${token("S").toLowerCase()}@fam.test`;
      const staffNumber = token("ST");
      const created = await createStaff(
        input(scope, {
          name: "Amina Staff",
          email,
          password: "temporary-password-123",
          staffNumber,
          phone: "0700000001",
          scopes: [
            { role: "doctor", facilityId: scope.facility.id, branchId: null },
            { role: "doctor", facilityId: scope.facility.id, branchId: null },
            { role: "receptionist", facilityId: scope.facility.id, branchId: scope.branchId },
          ],
        }),
        { database: ctx.db },
      );

      const scopes = await ctx.db
        .select()
        .from(staffRoleScopes)
        .where(eq(staffRoleScopes.userId, created.userId));
      expect(scopes).toHaveLength(2);
      expect(scopes.map((row) => row.role).sort()).toEqual(["doctor", "receptionist"]);

      const initialUser = await ctx.db.select().from(user).where(eq(user.id, created.userId));
      expect(initialUser[0]).toMatchObject({ role: "doctor", banned: false });

      await expect(
        createStaff(
          input(scope, {
            name: "Duplicate Email",
            email: email.toUpperCase(),
            password: "temporary-password-123",
            staffNumber: token("SE"),
            scopes: [{ role: "doctor", facilityId: scope.facility.id, branchId: null }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("A user with that email already exists");

      await expect(
        createStaff(
          input(scope, {
            name: "Duplicate Number",
            email: `other-${token("S").toLowerCase()}@fam.test`,
            password: "temporary-password-123",
            staffNumber,
            scopes: [{ role: "doctor", facilityId: scope.facility.id, branchId: null }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Staff number already exists");

      await expect(
        setStaffActive(input(scope, { userId: scope.actorId, active: false }), {
          database: ctx.db,
        }),
      ).rejects.toThrow("cannot deactivate your own account");

      const changed = await changeStaffRole(
        input(scope, { userId: created.userId, role: "admin" }),
        { database: ctx.db },
      );
      expect(changed).toEqual({ userId: created.userId, role: "admin" });
      const updatedUser = await ctx.db.select().from(user).where(eq(user.id, created.userId));
      expect(updatedUser[0].role).toBe("admin");
      const adminScopes = await ctx.db
        .select()
        .from(staffRoleScopes)
        .where(
          and(
            eq(staffRoleScopes.userId, created.userId),
            eq(staffRoleScopes.facilityId, scope.facility.id),
          ),
        );
      expect(adminScopes.every((row) => row.role === "admin")).toBe(true);

      const deactivated = await setStaffActive(
        input(scope, { userId: created.userId, active: false }),
        { database: ctx.db },
      );
      expect(deactivated).toEqual({ userId: created.userId, active: false });
      const afterDeactivation = await ctx.db
        .select()
        .from(user)
        .where(eq(user.id, created.userId));
      expect(afterDeactivation[0]).toMatchObject({
        banned: true,
        banReason: "Deactivated by administrator",
      });
      const profile = await ctx.db
        .select()
        .from(staffProfiles)
        .where(eq(staffProfiles.userId, created.userId));
      expect(profile[0].isActive).toBe(false);

      await expect(
        changeStaffRole(input(scope, { userId: newId(), role: "doctor" }), {
          database: ctx.db,
        }),
      ).rejects.toThrow("Staff scope not found");
    });
  });

  it("keeps catalog codes scoped and deactivates rows without deleting them", async () => {
    await withFacility(async (scope) => {
      const sharedItemCode = token("SHI");
      const sharedItem = await createItem(
        input(scope, {
          code: sharedItemCode,
          name: "Shared Consumable",
          kind: "consumable",
          unit: "box",
          shared: true,
        }),
        { database: ctx.db },
      );
      scope.sharedItemIds.push(sharedItem.itemId);

      await expect(
        createItem(
          input(scope, { code: sharedItemCode, name: "Local Duplicate", shared: false }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Item code already exists");

      const localItem = await createItem(
        input(scope, { code: token("ITM"), name: "Local Drug", shared: false }),
        { database: ctx.db },
      );
      const itemRows = await ctx.db.select().from(items).where(eq(items.id, localItem.itemId));
      expect(itemRows[0].facilityId).toBe(scope.facility.id);
      expect(await setItemActive(input(scope, { id: localItem.itemId, active: false }), {
        database: ctx.db,
      })).toMatchObject({ active: false });

      const labCode = token("SHL");
      const sharedLab = await createLabTest(
        input(scope, {
          code: labCode,
          name: "Shared Haemogram",
          sampleType: "Blood",
          shared: true,
          parameters: [
            {
              name: "Haemoglobin",
              unit: "g/dL",
              refLow: 12,
              refHigh: 16,
              criticalLow: 7,
              criticalHigh: 20,
            },
          ],
        }),
        { database: ctx.db },
      );
      scope.sharedLabTestIds.push(sharedLab.labTestId);
      await expect(
        createLabTest(
          input(scope, {
            code: labCode,
            name: "Duplicate Haemogram",
            sampleType: "Blood",
            shared: true,
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Laboratory test code already exists");

      const labTest = await createLabTest(
        input(scope, {
          code: token("LBT"),
          name: "Local Urinalysis",
          sampleType: "Urine",
          shared: false,
        }),
        { database: ctx.db },
      );
      expect(await setLabTestActive(input(scope, { id: labTest.labTestId, active: false }), {
        database: ctx.db,
      })).toMatchObject({ active: false });

      const serviceCode = token("SHS");
      const sharedService = await createService(
        input(scope, {
          code: serviceCode,
          name: "Shared Consultation",
          kind: "consultation",
          defaultPrice: "10.00",
          shared: true,
        }),
        { database: ctx.db },
      );
      scope.sharedServiceIds.push(sharedService.serviceId);
      await expect(
        createService(
          input(scope, {
            code: serviceCode,
            name: "Duplicate Consultation",
            kind: "consultation",
            shared: true,
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Service code already exists");

      const service = await createService(
        input(scope, {
          code: token("SRV"),
          name: "Local Procedure",
          kind: "procedure",
          defaultPrice: "25.50",
          shared: false,
        }),
        { database: ctx.db },
      );
      expect(await setServiceActive(input(scope, { id: service.serviceId, active: false }), {
        database: ctx.db,
      })).toMatchObject({ active: false });

      const itemAudit = await listAudit(ctx.db, scope.facility.id, {
        entity: "items",
        entityId: sharedItem.itemId,
      });
      expect(itemAudit).toHaveLength(1);
    });
  });

  it("enforces payer-unique price lists and upserts or removes prices", async () => {
    await withFacility(async (scope) => {
      const cash = await createPriceList(
        input(scope, { name: "Cash Prices", payerType: "cash" }),
        { database: ctx.db },
      );
      await expect(
        createPriceList(input(scope, { name: "Duplicate Cash", payerType: "cash" }), {
          database: ctx.db,
        }),
      ).rejects.toThrow("A price list for this payer already exists");

      const sha = await createPriceList(
        input(scope, { name: "SHA Prices", payerType: "sha" }),
        { database: ctx.db },
      );
      await expect(
        updatePriceList(input(scope, { id: sha.priceListId, payerType: "cash" }), {
          database: ctx.db,
        }),
      ).rejects.toThrow("A price list for this payer already exists");
      expect(await setPriceListActive(input(scope, { id: cash.priceListId, active: true }), {
        database: ctx.db,
      })).toMatchObject({ active: true });

      const service = await createService(
        input(scope, {
          code: token("PRS"),
          name: "Priced Consultation",
          kind: "consultation",
          defaultPrice: "0",
        }),
        { database: ctx.db },
      );
      const item = await createItem(
        input(scope, { code: token("PRI"), name: "Priced Item", unit: "tablet" }),
        { database: ctx.db },
      );

      const upsert = input(scope, {
        priceListId: cash.priceListId,
        targetType: "service",
        targetId: service.serviceId,
        amount: "12.50",
      });
      const first = await upsertPrice(upsert, { database: ctx.db });
      const second = await upsertPrice(
        { ...upsert, idempotencyKey: newIdempotencyKey(), amount: "15.75" },
        { database: ctx.db },
      );
      expect(second.priceId).toBe(first.priceId);

      const servicePrices = await ctx.db
        .select()
        .from(prices)
        .where(eq(prices.priceListId, cash.priceListId));
      expect(servicePrices).toHaveLength(1);
      expect(servicePrices[0]).toMatchObject({ amount: "15.75", serviceId: service.serviceId });

      const itemPrice = await upsertPrice(
        input(scope, {
          priceListId: cash.priceListId,
          targetType: "item",
          targetId: item.itemId,
          amount: "5.00",
        }),
        { database: ctx.db },
      );
      expect(itemPrice.priceId).not.toBe(first.priceId);

      const other = await insertTestFacility(ctx.db);
      scope.extraFacilityIds.push(other.id);
      const otherItem = await createItem(
        input(scope, {
          facilityId: other.id,
          code: token("OIT"),
          name: "Other Facility Item",
        }),
        { database: ctx.db },
      );
      await expect(
        upsertPrice(
          input(scope, {
            priceListId: cash.priceListId,
            targetType: "item",
            targetId: otherItem.itemId,
            amount: "1.00",
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("Item not found in this facility");

      await removePrice(input(scope, { id: itemPrice.priceId }), { database: ctx.db });
      const remaining = await ctx.db
        .select()
        .from(prices)
        .where(eq(prices.priceListId, cash.priceListId));
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(first.priceId);
      const priceListRows = await ctx.db
        .select()
        .from(priceLists)
        .where(eq(priceLists.facilityId, scope.facility.id));
      expect(priceListRows).toHaveLength(2);
    });
  });

  it("imports ICD-10 rows idempotently and updates existing codes", async () => {
    await withFacility(async (scope) => {
      const firstCode = token("Q");
      const secondCode = token("R");
      scope.icdCodes.push(firstCode, secondCode);

      const payload = input(scope, {
        rows: [
          { code: firstCode.toLowerCase(), description: "First code", chapter: "I" },
          { code: firstCode, description: "Duplicate row", chapter: "I" },
          { code: secondCode, description: "Second code", chapter: "I" },
        ],
      });
      const idempotencyKey = newIdempotencyKey();
      const first = await importIcd10({ ...payload, idempotencyKey }, { database: ctx.db });
      expect(first).toEqual({ rows: 2, inserted: 2, updated: 0 });

      const replayed = await importIcd10(
        {
          ...payload,
          idempotencyKey,
          rows: [{ code: secondCode, description: "Must not be applied" }],
        },
        { database: ctx.db },
      );
      expect(replayed).toEqual(first);

      const second = await importIcd10(
        input(scope, {
          rows: [{ code: firstCode, description: "Updated code", chapter: "II" }],
        }),
        { database: ctx.db },
      );
      expect(second).toEqual({ rows: 1, inserted: 0, updated: 1 });

      const codes = await ctx.db
        .select()
        .from(icd10Codes)
        .where(inArray(icd10Codes.code, [firstCode, secondCode]));
      expect(codes).toHaveLength(2);
      expect(codes.find((row) => row.code === firstCode)).toMatchObject({
        description: "Updated code",
        chapter: "II",
      });
      expect(codes.find((row) => row.code === secondCode)?.description).toBe("Second code");

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.facilityId, scope.facility.id),
            eq(auditLog.action, "admin.icd10.import"),
          ),
        );
      expect(audits).toHaveLength(2);
    });
  });

  it("filters the audit log and keeps one result per idempotency key", async () => {
    await withFacility(async (scope) => {
      const from = new Date(Date.now() - 60_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();

      const service = await createService(
        input(scope, {
          code: token("AUD"),
          name: "Audited Service",
          kind: "consultation",
          defaultPrice: "1.00",
        }),
        { database: ctx.db },
      );

      const idempotencyKey = newIdempotencyKey();
      const branch = await createBranch(
        {
          ...input(scope, { code: token("KEY"), name: "Key Branch" }),
          idempotencyKey,
        },
        { database: ctx.db },
      );
      await expect(
        updateBranch(
          {
            ...input(scope, { id: branch.branchId, name: "Must not run" }),
            idempotencyKey,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("different command");

      const filtered = await listAudit(ctx.db, scope.facility.id, {
        userId: scope.actorId,
        action: "admin.service.create",
        module: "admin",
        entity: "services",
        entityId: service.serviceId,
        from,
        to,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({
        action: "admin.service.create",
        module: "admin",
        entity: "services",
        entity_id: service.serviceId,
        user_id: scope.actorId,
      });

      expect(
        await listAudit(ctx.db, scope.facility.id, { action: "no.such.admin.action" }),
      ).toHaveLength(0);
      expect(await listAudit(ctx.db, scope.facility.id, 1)).toHaveLength(1);
    });
  });
});
