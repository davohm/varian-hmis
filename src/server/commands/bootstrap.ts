import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { ADMIN_SECTIONS } from "@/lib/admin-sections";
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  DEFAULT_COST_CENTER,
  normalBalanceFor,
} from "@/lib/finance";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import { db, type AppDatabase } from "@/server/db/client";
import {
  account,
  adminSectionPermissions,
  branches,
  costCenters,
  facilities,
  ledgerAccounts,
  staffProfiles,
  staffRoleScopes,
  user,
} from "@/server/db/schema";
import { seedRegulatoryDefaults } from "@/server/regulatory-seed";

import { CommandConflictError, type CommandOptions, type CommandTransaction } from "./run";

const optionalText = z.string().trim().max(255).nullable().optional();
const optionalLongText = z.string().trim().max(2000).nullable().optional();
const nameSchema = z.string().trim().min(2).max(120);
const codeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, numbers, dots, dashes or underscores");

const branchInputSchema = z.object({
  code: codeSchema.transform((value) => value.toUpperCase()),
  name: nameSchema,
  physicalLocation: optionalLongText,
  telephone: optionalText,
  managerName: optionalText,
  isMain: z.boolean().default(false),
});

export const bootstrapFirstRunSchema = z.object({
  idempotencyKey: z.uuid(),
  admin: z.object({
    name: nameSchema,
    email: z.email().max(255).transform((value) => value.toLowerCase()),
    password: z.string().min(10).max(128),
    phone: z.string().trim().max(50).nullable().optional(),
    staffNumber: codeSchema.transform((value) => value.toUpperCase()).default("SA-001"),
  }),
  facility: z.object({
    code: codeSchema.transform((value) => value.toUpperCase()),
    name: nameSchema,
    registrationDetails: optionalLongText,
    physicalAddress: optionalLongText,
    county: optionalText,
    phone: optionalText,
    email: z.email().max(255).nullable().optional(),
    logoUrl: z.string().trim().url().max(2048).nullable().optional(),
    currency: z.string().trim().length(3).toUpperCase().default("KES"),
    timezone: z.string().trim().min(3).max(64).default("Africa/Nairobi"),
    writeAuthority: z.enum(["cloud", "clinic"]).default("cloud"),
  }),
  branches: z.array(branchInputSchema).min(1, "At least one branch is required"),
});

export type BootstrapFirstRunInput = z.input<typeof bootstrapFirstRunSchema>;

export interface FirstRunStatus {
  required: boolean;
  facilityCount: number;
  superAdminCount: number;
}

async function countRows(tx: CommandTransaction, query: ReturnType<typeof sql>) {
  const result = await tx.execute(query);
  const rows = (result as { rows?: Array<{ count?: string | number }> }).rows ?? [];
  return Number(rows[0]?.count ?? 0);
}

export async function getFirstRunStatus(database: AppDatabase = db): Promise<FirstRunStatus> {
  return database.transaction(async (tx) => {
    const facilityCount = await countRows(tx, sql`SELECT COUNT(*)::int AS count FROM facilities`);
    const superAdminCount = await countRows(
      tx,
      sql`
        SELECT COUNT(DISTINCT srs.user_id)::int AS count
        FROM staff_role_scopes srs
        WHERE srs.role = 'super_admin'
      `,
    );
    return {
      required: facilityCount === 0 && superAdminCount === 0,
      facilityCount,
      superAdminCount,
    };
  });
}

async function seedChartOfAccounts(tx: CommandTransaction, facilityId: string, branchId: string) {
  for (const entry of DEFAULT_CHART_OF_ACCOUNTS) {
    await tx
      .insert(ledgerAccounts)
      .values({
        id: newId(),
        facilityId,
        code: entry.code,
        name: entry.name,
        type: entry.type,
        normalBalance: normalBalanceFor(entry.type),
        systemRole: entry.systemRole,
        createdBy: "bootstrap",
      })
      .onConflictDoNothing({ target: [ledgerAccounts.facilityId, ledgerAccounts.code] });
  }

  await tx
    .insert(costCenters)
    .values({
      id: newId(),
      facilityId,
      branchId,
      code: DEFAULT_COST_CENTER.code,
      name: DEFAULT_COST_CENTER.name,
      createdBy: "bootstrap",
    })
    .onConflictDoNothing({ target: [costCenters.facilityId, costCenters.code] });
}

export async function bootstrapFirstRun(
  input: BootstrapFirstRunInput,
  options: CommandOptions = {},
) {
  const values = bootstrapFirstRunSchema.parse(input);
  const executor = options.database ?? db;
  const passwordHash = await hashPassword(values.admin.password);

  return executor.transaction(async (tx) => {
    const existingCommand = await tx.execute(sql`
      SELECT command, result
      FROM command_log
      WHERE idempotency_key = ${values.idempotencyKey}::uuid
      LIMIT 1
    `);
    const existingRows =
      (existingCommand as unknown as { rows?: Array<{ command: string; result: unknown }> }).rows ?? [];
    if (existingRows[0]) {
      if (existingRows[0].command !== "bootstrapFirstRun") throw new CommandConflictError();
      return existingRows[0].result;
    }

    const facilityCount = await countRows(tx, sql`SELECT COUNT(*)::int AS count FROM facilities`);
    const superAdminCount = await countRows(
      tx,
      sql`SELECT COUNT(DISTINCT user_id)::int AS count FROM staff_role_scopes WHERE role = 'super_admin'`,
    );
    if (facilityCount > 0 || superAdminCount > 0) {
      throw new Error("Initial setup has already been completed");
    }

    const existingEmail = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, values.admin.email))
      .limit(1);
    if (existingEmail[0]) throw new Error("A user with that email already exists");

    const facilityId = newId();
    const adminUserId = newId();
    const now = new Date();
    const normalizedBranches = values.branches.map((branch, index) => ({
      ...branch,
      isMain: branch.isMain || (index === 0 && !values.branches.some((b) => b.isMain)),
    }));
    const mainCount = normalizedBranches.filter((b) => b.isMain).length;
    if (mainCount !== 1) throw new Error("Exactly one branch must be marked as main");

    await tx.insert(facilities).values({
      id: facilityId,
      code: values.facility.code,
      name: values.facility.name,
      registrationDetails: values.facility.registrationDetails ?? null,
      physicalAddress: values.facility.physicalAddress ?? null,
      county: values.facility.county ?? null,
      phone: values.facility.phone ?? null,
      email: values.facility.email ?? null,
      logoUrl: values.facility.logoUrl ?? null,
      currency: values.facility.currency,
      writeAuthority: values.facility.writeAuthority,
      timezone: values.facility.timezone,
      active: true,
      createdBy: adminUserId,
      createdAt: now,
      updatedAt: now,
    });

    const createdBranches: Array<{ id: string; code: string; name: string; isMain: boolean }> = [];
    for (const branch of normalizedBranches) {
      const branchId = newId();
      await tx.insert(branches).values({
        id: branchId,
        facilityId,
        code: branch.code,
        name: branch.name,
        physicalLocation: branch.physicalLocation ?? null,
        telephone: branch.telephone ?? null,
        managerName: branch.managerName ?? null,
        isMain: branch.isMain,
        active: true,
        createdBy: adminUserId,
        createdAt: now,
        updatedAt: now,
      });
      createdBranches.push({ id: branchId, code: branch.code, name: branch.name, isMain: branch.isMain });
    }

    const mainBranch = createdBranches.find((b) => b.isMain) ?? createdBranches[0];

    await tx.insert(user).values({
      id: adminUserId,
      name: values.admin.name,
      email: values.admin.email,
      emailVerified: true,
      role: "super_admin",
      banned: false,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(account).values({
      id: newId(),
      accountId: adminUserId,
      providerId: "credential",
      userId: adminUserId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(staffProfiles).values({
      id: newId(),
      userId: adminUserId,
      staffNumber: values.admin.staffNumber,
      phone: values.admin.phone ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(staffRoleScopes).values({
      id: newId(),
      userId: adminUserId,
      role: "super_admin",
      facilityId,
      branchId: null,
      createdAt: now,
    });

    await tx.insert(adminSectionPermissions).values(
      ADMIN_SECTIONS.map((section) => ({
        id: newId(),
        userId: adminUserId,
        facilityId,
        section,
        createdAt: now,
        updatedAt: now,
      })),
    );

    await seedChartOfAccounts(tx, facilityId, mainBranch.id);
    await seedRegulatoryDefaults(tx as unknown as Parameters<typeof seedRegulatoryDefaults>[0], facilityId);

    const result = {
      ok: true,
      facilityId,
      facilityCode: values.facility.code,
      adminUserId,
      adminEmail: values.admin.email,
      branchIds: createdBranches.map((b) => b.id),
      mainBranchId: mainBranch.id,
    };

    await tx.execute(sql`
      INSERT INTO command_log (idempotency_key, facility_id, command, result, created_at)
      VALUES (
        ${values.idempotencyKey}::uuid,
        ${facilityId}::uuid,
        ${"bootstrapFirstRun"}::text,
        ${JSON.stringify(result)}::jsonb,
        now()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `);

    await recordAudit(tx, {
      facilityId,
      userId: adminUserId,
      action: "bootstrap.first_run",
      module: "system",
      entity: "facilities",
      entityId: facilityId,
      details: {
        facilityCode: values.facility.code,
        branchCodes: createdBranches.map((b) => b.code),
        adminEmail: values.admin.email,
      },
    });

    return result;
  });
}
