import { and, eq, inArray } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import { account, branches, facilities, staffProfiles, staffRoleScopes, user } from "@/server/db/schema";

import { runCommand, type CommandOptions, type CommandTransaction } from "../run";
import {
  adminBaseSchema,
  codeSchema,
  requireActor,
  roleSchema,
  scopeSchema,
  uniqueScopes,
  verifyManagedFacilities,
  writeAdminAudit,
} from "./shared";

const nameSchema = z.string().trim().min(2).max(120);
const emailSchema = z.email().max(255).transform((value) => value.toLowerCase());
const phoneSchema = z.string().trim().max(50).nullable().optional();

export const createStaffSchema = z.object({
  ...adminBaseSchema,
  name: nameSchema,
  email: emailSchema,
  password: z.string().min(10).max(128),
  staffNumber: codeSchema.transform((value) => value.toUpperCase()),
  phone: phoneSchema,
  scopes: z.array(scopeSchema).min(1, "At least one role scope is required"),
  allowedFacilityIds: z.array(z.uuid()).optional(),
});
export type CreateStaffInput = z.input<typeof createStaffSchema>;

export const updateStaffSchema = z
  .object({
    ...adminBaseSchema,
    userId: z.string().min(1),
    name: nameSchema.optional(),
    phone: phoneSchema,
    isActive: z.boolean().optional(),
    scopes: z.array(scopeSchema).min(1).optional(),
    allowedFacilityIds: z.array(z.uuid()).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.phone !== undefined ||
      value.isActive !== undefined ||
      value.scopes !== undefined,
    "No staff changes supplied",
  );
export type UpdateStaffInput = z.input<typeof updateStaffSchema>;

export const setStaffActiveSchema = z.object({
  ...adminBaseSchema,
  userId: z.string().min(1),
  active: z.boolean(),
});
export type SetStaffActiveInput = z.input<typeof setStaffActiveSchema>;

export const changeStaffRoleSchema = z.object({
  ...adminBaseSchema,
  userId: z.string().min(1),
  role: roleSchema,
});
export type ChangeStaffRoleInput = z.input<typeof changeStaffRoleSchema>;

async function requireSuperAdminActor(tx: CommandTransaction, facilityId: string, actorId: string) {
  const rows = await tx
    .select({ role: staffRoleScopes.role })
    .from(staffRoleScopes)
    .where(
      and(
        eq(staffRoleScopes.userId, actorId),
        eq(staffRoleScopes.facilityId, facilityId),
        eq(staffRoleScopes.role, "super_admin"),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("Only a super administrator can assign the super_admin role");
}

async function requireStaffUser(tx: CommandTransaction, userId: string) {
  const rows = await tx
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      isActive: staffProfiles.isActive,
      staffNumber: staffProfiles.staffNumber,
    })
    .from(user)
    .innerJoin(staffProfiles, eq(staffProfiles.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  if (!rows[0]) throw new Error("Staff member not found");
  return rows[0];
}

async function validateScopes(tx: CommandTransaction, scopes: z.infer<typeof scopeSchema>[]) {
  for (const scope of scopes) {
    const facilityRows = await tx
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.id, scope.facilityId))
      .limit(1);
    if (!facilityRows[0]) throw new Error("Role scope references an unknown facility");

    if (scope.branchId) {
      const branchRows = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, scope.branchId), eq(branches.facilityId, scope.facilityId)))
        .limit(1);
      if (!branchRows[0]) throw new Error("Role scope branch does not belong to its facility");
    }
  }
  return uniqueScopes(scopes);
}

export async function createStaff(input: CreateStaffInput, options: CommandOptions = {}) {
  const values = createStaffSchema.parse(input);
  const actorId = requireActor(values.actor);
  const scopes = uniqueScopes(values.scopes);
  verifyManagedFacilities(scopes.map((scope) => scope.facilityId), values.allowedFacilityIds);
  const passwordHash = await hashPassword(values.password);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createStaff",
    async (tx) => {
      if (scopes.some((scope) => scope.role === "super_admin")) {
        await requireSuperAdminActor(tx, values.facilityId, actorId);
      }
      const existingEmail = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, values.email))
        .limit(1);
      if (existingEmail[0]) throw new Error("A user with that email already exists");

      const existingNumber = await tx
        .select({ id: staffProfiles.id })
        .from(staffProfiles)
        .where(eq(staffProfiles.staffNumber, values.staffNumber))
        .limit(1);
      if (existingNumber[0]) throw new Error("Staff number already exists");

      await validateScopes(tx, scopes);

      const userId = newId();
      const now = new Date();
      await tx.insert(user).values({
        id: userId,
        name: values.name,
        email: values.email,
        emailVerified: true,
        role: scopes[0].role,
        banned: false,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(account).values({
        id: newId(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(staffProfiles).values({
        id: newId(),
        userId,
        staffNumber: values.staffNumber,
        phone: values.phone ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(staffRoleScopes).values(
        scopes.map((scope) => ({
          id: newId(),
          userId,
          role: scope.role,
          facilityId: scope.facilityId,
          branchId: scope.branchId ?? null,
          createdAt: now,
        })),
      );

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.staff.create",
        entity: "staff_profiles",
        entityId: userId,
        details: {
          email: values.email,
          staffNumber: values.staffNumber,
          roles: scopes.map((scope) => scope.role),
        },
      });

      return { userId, staffNumber: values.staffNumber };
    },
    options,
  );
}

export async function updateStaff(input: UpdateStaffInput, options: CommandOptions = {}) {
  const values = updateStaffSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateStaff",
    async (tx) => {
      const current = await requireStaffUser(tx, values.userId);
      if (values.isActive === false && values.userId === actorId) {
        throw new Error("You cannot deactivate your own account");
      }
      if (values.scopes) {
        verifyManagedFacilities(
          values.scopes.map((scope) => scope.facilityId),
          values.allowedFacilityIds,
        );
        const scopes = await validateScopes(tx, values.scopes);
        if (scopes.some((scope) => scope.role === "super_admin")) {
          await requireSuperAdminActor(tx, values.facilityId, actorId);
        }

        const conditions = [eq(staffRoleScopes.userId, values.userId)];
        if (values.allowedFacilityIds) {
          conditions.push(inArray(staffRoleScopes.facilityId, values.allowedFacilityIds));
        }
        await tx.delete(staffRoleScopes).where(and(...conditions));
        await tx.insert(staffRoleScopes).values(
          scopes.map((scope) => ({
            id: newId(),
            userId: values.userId,
            role: scope.role,
            facilityId: scope.facilityId,
            branchId: scope.branchId ?? null,
            createdAt: new Date(),
          })),
        );
        await tx
          .update(user)
          .set({ role: scopes[0].role, updatedAt: new Date() })
          .where(eq(user.id, values.userId));
      }

      await tx
        .update(user)
        .set({
          name: values.name ?? current.name,
          banned: values.isActive === undefined ? undefined : !values.isActive,
          updatedAt: new Date(),
        })
        .where(eq(user.id, values.userId));
      await tx
        .update(staffProfiles)
        .set({
          phone: values.phone === undefined ? undefined : values.phone,
          isActive: values.isActive ?? current.isActive,
          updatedAt: new Date(),
        })
        .where(eq(staffProfiles.userId, values.userId));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.staff.update",
        entity: "staff_profiles",
        entityId: values.userId,
        details: {
          name: values.name,
          phone: values.phone,
          isActive: values.isActive,
          roles: values.scopes?.map((scope) => scope.role),
        },
      });

      return { userId: values.userId };
    },
    options,
  );
}

export async function setStaffActive(input: SetStaffActiveInput, options: CommandOptions = {}) {
  const values = setStaffActiveSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setStaffActive",
    async (tx) => {
      await requireStaffUser(tx, values.userId);
      if (values.userId === actorId && !values.active) {
        throw new Error("You cannot deactivate your own account");
      }

      await tx
        .update(staffProfiles)
        .set({ isActive: values.active, updatedAt: new Date() })
        .where(eq(staffProfiles.userId, values.userId));
      await tx
        .update(user)
        .set({
          banned: !values.active,
          banReason: values.active ? null : "Deactivated by administrator",
          updatedAt: new Date(),
        })
        .where(eq(user.id, values.userId));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.staff.setActive",
        entity: "staff_profiles",
        entityId: values.userId,
        details: { active: values.active },
      });

      return { userId: values.userId, active: values.active };
    },
    options,
  );
}

export async function changeStaffRole(input: ChangeStaffRoleInput, options: CommandOptions = {}) {
  const values = changeStaffRoleSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "changeStaffRole",
    async (tx) => {
      if (values.role === "super_admin") {
        await requireSuperAdminActor(tx, values.facilityId, actorId);
      }
      const current = await tx
        .select({ role: staffRoleScopes.role })
        .from(staffRoleScopes)
        .where(
          and(eq(staffRoleScopes.userId, values.userId), eq(staffRoleScopes.facilityId, values.facilityId)),
        )
        .limit(1);
      if (!current[0]) throw new Error("Staff scope not found");

      await tx
        .update(staffRoleScopes)
        .set({ role: values.role })
        .where(
          and(eq(staffRoleScopes.userId, values.userId), eq(staffRoleScopes.facilityId, values.facilityId)),
        );
      await tx
        .update(user)
        .set({ role: values.role, updatedAt: new Date() })
        .where(eq(user.id, values.userId));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.staff.changeRole",
        entity: "staff_role_scopes",
        entityId: values.userId,
        details: { from: current[0].role, to: values.role },
      });

      return { userId: values.userId, role: values.role };
    },
    options,
  );
}
