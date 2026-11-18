import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import {
  branches,
  departments,
  facilities,
  rooms,
  staffRoleScopes,
  stores,
} from "@/server/db/schema";

import { runCommand, type CommandOptions, type CommandTransaction } from "../run";
import { adminBaseSchema, codeSchema, requireActor, writeAdminAudit } from "./shared";

const nameSchema = z.string().trim().min(2).max(120);
const optionalText = z.string().trim().max(255).nullable().optional();
const departmentKindSchema = z.enum([
  "opd",
  "triage",
  "reception",
  "lab",
  "pharmacy",
  "cashier",
  "admin",
  "other",
]);
const storeKindSchema = z.enum(["pharmacy", "main", "lab"]);
const writeAuthoritySchema = z.enum(["cloud", "clinic"]);
const managedSchema = z.object({
  allowedFacilityIds: z.array(z.uuid()).optional(),
});

const facilityFields = z.object({
  code: codeSchema.transform((value) => value.toUpperCase()).optional(),
  name: nameSchema.optional(),
  county: optionalText,
  phone: optionalText,
  email: z.email().max(255).nullable().optional(),
  writeAuthority: writeAuthoritySchema.optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
});

export const createFacilitySchema = z
  .object({
    ...adminBaseSchema,
    code: codeSchema.transform((value) => value.toUpperCase()),
    name: nameSchema,
    county: optionalText,
    phone: optionalText,
    email: z.email().max(255).nullable().optional(),
    writeAuthority: writeAuthoritySchema.default("cloud"),
    timezone: z.string().trim().min(3).max(64).default("Africa/Nairobi"),
  });
export type CreateFacilityInput = z.input<typeof createFacilitySchema>;

export const updateFacilitySchema = z
  .object({ ...adminBaseSchema, id: z.uuid(), ...managedSchema.shape, ...facilityFields.shape })
  .refine((value) => Object.keys(facilityFields.shape).some((key) => value[key as keyof typeof facilityFields.shape] !== undefined), "No facility changes supplied");
export type UpdateFacilityInput = z.input<typeof updateFacilitySchema>;

export const setFacilityActiveSchema = z.object({
  ...adminBaseSchema,
  ...managedSchema.shape,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetFacilityActiveInput = z.input<typeof setFacilityActiveSchema>;

export const createBranchSchema = z.object({
  ...adminBaseSchema,
  code: codeSchema.transform((value) => value.toUpperCase()),
  name: nameSchema,
  isMain: z.boolean().default(false),
});
export type CreateBranchInput = z.input<typeof createBranchSchema>;

export const updateBranchSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    code: codeSchema.transform((value) => value.toUpperCase()).optional(),
    name: nameSchema.optional(),
    isMain: z.boolean().optional(),
  })
  .refine((value) => value.code !== undefined || value.name !== undefined || value.isMain !== undefined, "No branch changes supplied");
export type UpdateBranchInput = z.input<typeof updateBranchSchema>;

export const setBranchActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetBranchActiveInput = z.input<typeof setBranchActiveSchema>;

export const createDepartmentSchema = z.object({
  ...adminBaseSchema,
  branchId: z.uuid(),
  name: nameSchema,
  kind: departmentKindSchema,
});
export type CreateDepartmentInput = z.input<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    branchId: z.uuid().optional(),
    name: nameSchema.optional(),
    kind: departmentKindSchema.optional(),
  })
  .refine((value) => value.branchId !== undefined || value.name !== undefined || value.kind !== undefined, "No department changes supplied");
export type UpdateDepartmentInput = z.input<typeof updateDepartmentSchema>;

export const setDepartmentActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetDepartmentActiveInput = z.input<typeof setDepartmentActiveSchema>;

export const createRoomSchema = z.object({
  ...adminBaseSchema,
  departmentId: z.uuid(),
  name: nameSchema,
});
export type CreateRoomInput = z.input<typeof createRoomSchema>;

export const updateRoomSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    departmentId: z.uuid().optional(),
    name: nameSchema.optional(),
  })
  .refine((value) => value.departmentId !== undefined || value.name !== undefined, "No room changes supplied");
export type UpdateRoomInput = z.input<typeof updateRoomSchema>;

export const setRoomActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetRoomActiveInput = z.input<typeof setRoomActiveSchema>;

export const createStoreSchema = z.object({
  ...adminBaseSchema,
  branchId: z.uuid(),
  name: nameSchema,
  kind: storeKindSchema,
});
export type CreateStoreInput = z.input<typeof createStoreSchema>;

export const updateStoreSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    branchId: z.uuid().optional(),
    name: nameSchema.optional(),
    kind: storeKindSchema.optional(),
  })
  .refine((value) => value.branchId !== undefined || value.name !== undefined || value.kind !== undefined, "No store changes supplied");
export type UpdateStoreInput = z.input<typeof updateStoreSchema>;

export const setStoreActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetStoreActiveInput = z.input<typeof setStoreActiveSchema>;

async function requireFacility(tx: CommandTransaction, facilityId: string) {
  const rows = await tx
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  if (!rows[0]) throw new Error("Facility not found");
  return rows[0];
}

async function requireBranch(tx: CommandTransaction, facilityId: string, branchId: string) {
  const rows = await tx
    .select({ id: branches.id, isMain: branches.isMain })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new Error("Branch not found in this facility");
  return rows[0];
}

async function requireDepartment(tx: CommandTransaction, facilityId: string, departmentId: string) {
  const rows = await tx
    .select({ id: departments.id, branchId: departments.branchId })
    .from(departments)
    .where(and(eq(departments.id, departmentId), eq(departments.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new Error("Department not found in this facility");
  return rows[0];
}

async function requireRow(tx: CommandTransaction, table: typeof rooms | typeof stores, facilityId: string, id: string) {
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new Error("Record not found in this facility");
  return rows[0];
}

function touch() {
  return { updatedAt: new Date(), version: sql`version + 1` };
}

export async function createFacility(input: CreateFacilityInput, options: CommandOptions = {}) {
  const values = createFacilitySchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createFacility",
    async (tx) => {
      const duplicate = await tx
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.code, values.code))
        .limit(1);
      if (duplicate[0]) throw new Error("Facility code already exists");

      const id = newId();
      await tx.insert(facilities).values({
        id,
        code: values.code,
        name: values.name,
        county: values.county ?? null,
        phone: values.phone ?? null,
        email: values.email ?? null,
        writeAuthority: values.writeAuthority,
        timezone: values.timezone,
        active: true,
        createdBy: actorId,
      });

      await tx
        .insert(staffRoleScopes)
        .values({
          id: newId(),
          userId: actorId,
          role: "admin",
          facilityId: id,
          branchId: null,
          createdAt: new Date(),
        })
        .onConflictDoNothing();

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.facility.create",
        entity: "facilities",
        entityId: id,
        details: { code: values.code, name: values.name, grantedAdminScope: true },
      });

      return { facilityId: id, code: values.code, name: values.name };
    },
    options,
  );
}

export async function updateFacility(input: UpdateFacilityInput, options: CommandOptions = {}) {
  const values = updateFacilitySchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateFacility",
    async (tx) => {
      const current = await requireFacility(tx, values.id);
      if (values.allowedFacilityIds && !values.allowedFacilityIds.includes(current.id)) {
        throw new Error("Facility is outside your administration scope");
      }
      if (values.code) {
        const duplicate = await tx
          .select({ id: facilities.id })
          .from(facilities)
          .where(and(eq(facilities.code, values.code), ne(facilities.id, values.id)))
          .limit(1);
        if (duplicate[0]) throw new Error("Facility code already exists");
      }

      await tx
        .update(facilities)
        .set({
          code: values.code,
          name: values.name,
          county: values.county,
          phone: values.phone,
          email: values.email,
          writeAuthority: values.writeAuthority,
          timezone: values.timezone,
          ...touch(),
        })
        .where(eq(facilities.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.facility.update",
        entity: "facilities",
        entityId: values.id,
        details: { changes: Object.keys(facilityFields.shape).filter((key) => values[key as keyof typeof facilityFields.shape] !== undefined) },
      });

      return { facilityId: values.id };
    },
    options,
  );
}

export async function setFacilityActive(input: SetFacilityActiveInput, options: CommandOptions = {}) {
  const values = setFacilityActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setFacilityActive",
    async (tx) => {
      const current = await requireFacility(tx, values.id);
      if (values.allowedFacilityIds && !values.allowedFacilityIds.includes(current.id)) {
        throw new Error("Facility is outside your administration scope");
      }
      if (!values.active && values.id === values.facilityId) {
        throw new Error("You cannot deactivate the active facility");
      }

      await tx
        .update(facilities)
        .set({ active: values.active, ...touch() })
        .where(eq(facilities.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.facility.setActive",
        entity: "facilities",
        entityId: values.id,
        details: { active: values.active },
      });

      return { facilityId: values.id, active: values.active };
    },
    options,
  );
}

export async function createBranch(input: CreateBranchInput, options: CommandOptions = {}) {
  const values = createBranchSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createBranch",
    async (tx) => {
      await requireFacility(tx, values.facilityId);
      const duplicate = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.facilityId, values.facilityId), eq(branches.code, values.code)))
        .limit(1);
      if (duplicate[0]) throw new Error("Branch code already exists in this facility");

      if (values.isMain) {
        await tx
          .update(branches)
          .set({ isMain: false, ...touch() })
          .where(and(eq(branches.facilityId, values.facilityId), eq(branches.isMain, true)));
      }

      const id = newId();
      await tx.insert(branches).values({
        id,
        facilityId: values.facilityId,
        code: values.code,
        name: values.name,
        isMain: values.isMain,
        active: true,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.branch.create",
        entity: "branches",
        entityId: id,
        details: { code: values.code, name: values.name, isMain: values.isMain },
      });

      return { branchId: id, code: values.code };
    },
    options,
  );
}

export async function updateBranch(input: UpdateBranchInput, options: CommandOptions = {}) {
  const values = updateBranchSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateBranch",
    async (tx) => {
      const current = await requireBranch(tx, values.facilityId, values.id);
      if (values.code) {
        const duplicate = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.facilityId, values.facilityId),
              eq(branches.code, values.code),
              ne(branches.id, values.id),
            ),
          )
          .limit(1);
        if (duplicate[0]) throw new Error("Branch code already exists in this facility");
      }

      if (values.isMain && !current.isMain) {
        await tx
          .update(branches)
          .set({ isMain: false, ...touch() })
          .where(and(eq(branches.facilityId, values.facilityId), eq(branches.isMain, true)));
      }

      await tx
        .update(branches)
        .set({
          code: values.code,
          name: values.name,
          isMain: values.isMain,
          ...touch(),
        })
        .where(and(eq(branches.id, values.id), eq(branches.facilityId, values.facilityId)));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.branch.update",
        entity: "branches",
        entityId: values.id,
        details: { code: values.code, name: values.name, isMain: values.isMain },
      });

      return { branchId: values.id };
    },
    options,
  );
}

export async function setBranchActive(input: SetBranchActiveInput, options: CommandOptions = {}) {
  const values = setBranchActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setBranchActive",
    async (tx) => {
      const branch = await requireBranch(tx, values.facilityId, values.id);
      if (!values.active && branch.isMain) throw new Error("The main branch cannot be deactivated");

      await tx
        .update(branches)
        .set({ active: values.active, ...touch() })
        .where(eq(branches.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.branch.setActive",
        entity: "branches",
        entityId: values.id,
        details: { active: values.active },
      });

      return { branchId: values.id, active: values.active };
    },
    options,
  );
}

export async function createDepartment(input: CreateDepartmentInput, options: CommandOptions = {}) {
  const values = createDepartmentSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createDepartment",
    async (tx) => {
      await requireBranch(tx, values.facilityId, values.branchId);
      const duplicate = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(
            eq(departments.facilityId, values.facilityId),
            eq(departments.branchId, values.branchId),
            eq(departments.name, values.name),
          ),
        )
        .limit(1);
      if (duplicate[0]) throw new Error("Department already exists in this branch");

      const id = newId();
      await tx.insert(departments).values({
        id,
        facilityId: values.facilityId,
        branchId: values.branchId,
        name: values.name,
        kind: values.kind,
        active: true,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.department.create",
        entity: "departments",
        entityId: id,
        details: { branchId: values.branchId, name: values.name, kind: values.kind },
      });

      return { departmentId: id, name: values.name };
    },
    options,
  );
}

export async function updateDepartment(input: UpdateDepartmentInput, options: CommandOptions = {}) {
  const values = updateDepartmentSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateDepartment",
    async (tx) => {
      const current = await requireDepartment(tx, values.facilityId, values.id);
      const branchId = values.branchId ?? current.branchId;
      await requireBranch(tx, values.facilityId, branchId);

      await tx
        .update(departments)
        .set({
          branchId,
          name: values.name,
          kind: values.kind,
          ...touch(),
        })
        .where(eq(departments.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.department.update",
        entity: "departments",
        entityId: values.id,
        details: { branchId, name: values.name, kind: values.kind },
      });

      return { departmentId: values.id };
    },
    options,
  );
}

export async function setDepartmentActive(input: SetDepartmentActiveInput, options: CommandOptions = {}) {
  const values = setDepartmentActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setDepartmentActive",
    async (tx) => {
      await requireDepartment(tx, values.facilityId, values.id);
      await tx
        .update(departments)
        .set({ active: values.active, ...touch() })
        .where(eq(departments.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.department.setActive",
        entity: "departments",
        entityId: values.id,
        details: { active: values.active },
      });

      return { departmentId: values.id, active: values.active };
    },
    options,
  );
}

export async function createRoom(input: CreateRoomInput, options: CommandOptions = {}) {
  const values = createRoomSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createRoom",
    async (tx) => {
      await requireDepartment(tx, values.facilityId, values.departmentId);
      const duplicate = await tx
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.departmentId, values.departmentId), eq(rooms.name, values.name)))
        .limit(1);
      if (duplicate[0]) throw new Error("Room already exists in this department");

      const id = newId();
      await tx.insert(rooms).values({
        id,
        facilityId: values.facilityId,
        departmentId: values.departmentId,
        name: values.name,
        active: true,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.room.create",
        entity: "rooms",
        entityId: id,
        details: { departmentId: values.departmentId, name: values.name },
      });

      return { roomId: id, name: values.name };
    },
    options,
  );
}

export async function updateRoom(input: UpdateRoomInput, options: CommandOptions = {}) {
  const values = updateRoomSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateRoom",
    async (tx) => {
      const current = await requireRow(tx, rooms, values.facilityId, values.id);
      void current;
      const departmentId = values.departmentId ?? (
        await tx
          .select({ departmentId: rooms.departmentId })
          .from(rooms)
          .where(eq(rooms.id, values.id))
          .limit(1)
      )[0]?.departmentId;
      if (!departmentId) throw new Error("Room not found in this facility");
      await requireDepartment(tx, values.facilityId, departmentId);

      await tx
        .update(rooms)
        .set({ departmentId, name: values.name, ...touch() })
        .where(eq(rooms.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.room.update",
        entity: "rooms",
        entityId: values.id,
        details: { departmentId, name: values.name },
      });

      return { roomId: values.id };
    },
    options,
  );
}

export async function setRoomActive(input: SetRoomActiveInput, options: CommandOptions = {}) {
  const values = setRoomActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setRoomActive",
    async (tx) => {
      await requireRow(tx, rooms, values.facilityId, values.id);
      await tx
        .update(rooms)
        .set({ active: values.active, ...touch() })
        .where(eq(rooms.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.room.setActive",
        entity: "rooms",
        entityId: values.id,
        details: { active: values.active },
      });

      return { roomId: values.id, active: values.active };
    },
    options,
  );
}

export async function createStore(input: CreateStoreInput, options: CommandOptions = {}) {
  const values = createStoreSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createStore",
    async (tx) => {
      await requireBranch(tx, values.facilityId, values.branchId);
      const duplicate = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(
          and(
            eq(stores.facilityId, values.facilityId),
            eq(stores.branchId, values.branchId),
            eq(stores.name, values.name),
          ),
        )
        .limit(1);
      if (duplicate[0]) throw new Error("Store already exists in this branch");

      const id = newId();
      await tx.insert(stores).values({
        id,
        facilityId: values.facilityId,
        branchId: values.branchId,
        name: values.name,
        kind: values.kind,
        active: true,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.store.create",
        entity: "stores",
        entityId: id,
        details: { branchId: values.branchId, name: values.name, kind: values.kind },
      });

      return { storeId: id, name: values.name };
    },
    options,
  );
}

export async function updateStore(input: UpdateStoreInput, options: CommandOptions = {}) {
  const values = updateStoreSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateStore",
    async (tx) => {
      const current = await requireRow(tx, stores, values.facilityId, values.id);
      void current;
      const existing = await tx
        .select({ branchId: stores.branchId })
        .from(stores)
        .where(eq(stores.id, values.id))
        .limit(1);
      const branchId = values.branchId ?? existing[0]?.branchId;
      if (!branchId) throw new Error("Store not found in this facility");
      await requireBranch(tx, values.facilityId, branchId);

      await tx
        .update(stores)
        .set({ branchId, name: values.name, kind: values.kind, ...touch() })
        .where(eq(stores.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.store.update",
        entity: "stores",
        entityId: values.id,
        details: { branchId, name: values.name, kind: values.kind },
      });

      return { storeId: values.id };
    },
    options,
  );
}

export async function setStoreActive(input: SetStoreActiveInput, options: CommandOptions = {}) {
  const values = setStoreActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setStoreActive",
    async (tx) => {
      await requireRow(tx, stores, values.facilityId, values.id);
      await tx
        .update(stores)
        .set({ active: values.active, ...touch() })
        .where(eq(stores.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.store.setActive",
        entity: "stores",
        entityId: values.id,
        details: { active: values.active },
      });

      return { storeId: values.id, active: values.active };
    },
    options,
  );
}
