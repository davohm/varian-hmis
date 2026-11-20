import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import type { BudgetStatus } from "@/lib/finance";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import {
  branches,
  budgetLines,
  budgets,
  costCenters,
  fiscalPeriods,
  ledgerAccounts,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";

import { actorSchema, runCommand, type CommandOptions, type CommandTransaction } from "./run";

const baseSchema = {
  facilityId: z.uuid(),
  idempotencyKey: z.uuid(),
  actor: actorSchema,
};

function actorId(values: { actor: { userId?: string | null } }): string {
  if (!values.actor.userId) throw new Error("A signed-in user is required");
  return values.actor.userId;
}

const positiveMoney = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)))
  .refine((value) => toCents(value) > 0, "Budget amounts must be greater than zero");

const budgetLineInputSchema = z.object({
  accountId: z.uuid(),
  costCenterId: z.uuid().nullable().optional(),
  amount: positiveMoney,
  description: z.string().trim().max(500).nullable().optional(),
});

const budgetLinesSchema = z.array(budgetLineInputSchema).min(1).max(100);

function totalAmount(lines: Array<{ amount: string }>): string {
  return fromCents(lines.reduce((total, line) => total + toCents(line.amount), 0));
}

function assertUniqueLines(lines: Array<{ accountId: string; costCenterId?: string | null }>) {
  const keys = lines.map((line) => `${line.accountId}:${line.costCenterId ?? ""}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Each account and cost centre combination can appear only once in a budget");
  }
}

async function assertBudgetContext(
  tx: CommandTransaction,
  facilityId: string,
  periodId: string,
  branchId?: string | null,
  costCenterId?: string | null,
) {
  const periods = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.facilityId, facilityId), eq(fiscalPeriods.id, periodId)))
    .limit(1);
  if (!periods[0]) throw new Error("Fiscal period not found in this facility");

  if (branchId) {
    const rows = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.facilityId, facilityId), eq(branches.id, branchId)))
      .limit(1);
    if (!rows[0]) throw new Error("Budget branch not found in this facility");
  }

  if (costCenterId) {
    const rows = await tx
      .select({ id: costCenters.id, branchId: costCenters.branchId })
      .from(costCenters)
      .where(and(eq(costCenters.facilityId, facilityId), eq(costCenters.id, costCenterId)))
      .limit(1);
    if (!rows[0]) throw new Error("Budget cost centre not found in this facility");
    if (branchId && rows[0].branchId !== branchId) {
      throw new Error("The cost centre belongs to a different branch");
    }
  }
}

async function assertExpenseAccounts(
  tx: CommandTransaction,
  facilityId: string,
  accountIds: string[],
) {
  const rows = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.facilityId, facilityId),
        eq(ledgerAccounts.type, "expense"),
        eq(ledgerAccounts.active, true),
        inArray(ledgerAccounts.id, accountIds),
      ),
    );
  if (rows.length !== new Set(accountIds).size) {
    throw new Error("Budget lines must reference active expense accounts in this facility");
  }
}

async function assertLineDimensions(
  tx: CommandTransaction,
  facilityId: string,
  lines: Array<{ costCenterId?: string | null }>,
) {
  const ids = [...new Set(lines.map((line) => line.costCenterId).filter(Boolean))] as string[];
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: costCenters.id })
    .from(costCenters)
    .where(and(eq(costCenters.facilityId, facilityId), inArray(costCenters.id, ids)));
  if (rows.length !== ids.length) {
    throw new Error("Every budget line cost centre must belong to this facility");
  }
}

async function insertLines(
  tx: CommandTransaction,
  budgetId: string,
  facilityId: string,
  userId: string,
  lines: Array<{
    accountId: string;
    costCenterId?: string | null;
    amount: string;
    description?: string | null;
  }>,
) {
  await tx.insert(budgetLines).values(
    lines.map((line) => ({
      id: newId(),
      facilityId,
      budgetId,
      accountId: line.accountId,
      costCenterId: line.costCenterId ?? null,
      amount: line.amount,
      description: line.description?.trim() || null,
      createdBy: userId,
    })),
  );
}

export interface BudgetResult {
  budgetId: string;
  code: string;
  name: string;
  status: BudgetStatus;
  version: number;
  total: string;
}

async function readBudgetResult(
  tx: CommandTransaction,
  facilityId: string,
  budgetId: string,
): Promise<BudgetResult> {
  const rows = await tx
    .select({
      id: budgets.id,
      code: budgets.code,
      name: budgets.name,
      status: budgets.status,
      version: budgets.version,
    })
    .from(budgets)
    .where(and(eq(budgets.facilityId, facilityId), eq(budgets.id, budgetId)))
    .limit(1);
  const budget = rows[0];
  if (!budget) throw new Error("Budget not found in this facility");

  const lines = await tx
    .select({ amount: budgetLines.amount })
    .from(budgetLines)
    .where(and(eq(budgetLines.facilityId, facilityId), eq(budgetLines.budgetId, budgetId)));
  return {
    budgetId: budget.id,
    code: budget.code,
    name: budget.name,
    status: budget.status,
    version: budget.version,
    total: totalAmount(lines),
  };
}

/* ------------------------------------------------------------------ */
/* Create and revise                                                   */
/* ------------------------------------------------------------------ */

export const createBudgetSchema = z.object({
  ...baseSchema,
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9.-]+$/, "Use letters, numbers, dots or dashes"),
  name: z.string().trim().min(1).max(200),
  periodId: z.uuid(),
  branchId: z.uuid().nullable().optional(),
  costCenterId: z.uuid().nullable().optional(),
  enforce: z.boolean().default(true),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: budgetLinesSchema,
});

export type CreateBudgetInput = z.input<typeof createBudgetSchema>;

export async function createBudget(
  input: CreateBudgetInput,
  options: CommandOptions = {},
): Promise<BudgetResult> {
  const values = createBudgetSchema.parse(input);
  const userId = actorId(values);
  const code = values.code.toUpperCase();
  assertUniqueLines(values.lines);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createBudget",
    async (tx) => {
      const duplicate = await tx
        .select({ id: budgets.id })
        .from(budgets)
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.code, code)))
        .limit(1);
      if (duplicate[0]) throw new Error(`Budget ${code} already exists`);

      await assertBudgetContext(
        tx,
        values.facilityId,
        values.periodId,
        values.branchId,
        values.costCenterId,
      );
      await assertExpenseAccounts(
        tx,
        values.facilityId,
        values.lines.map((line) => line.accountId),
      );
      await assertLineDimensions(tx, values.facilityId, values.lines);

      const budgetId = newId();
      await tx.insert(budgets).values({
        id: budgetId,
        facilityId: values.facilityId,
        periodId: values.periodId,
        branchId: values.branchId ?? null,
        costCenterId: values.costCenterId ?? null,
        code,
        name: values.name,
        status: "draft",
        version: 1,
        currency: "KES",
        enforce: values.enforce,
        note: values.note?.trim() || null,
        createdBy: userId,
      });
      await insertLines(tx, budgetId, values.facilityId, userId, values.lines);

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "budget.create",
        module: "finance",
        entity: "budgets",
        entityId: budgetId,
        details: { code, name: values.name, total: totalAmount(values.lines) },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "budget.created",
        facilityId: values.facilityId,
        budgetId,
        code,
      });

      return readBudgetResult(tx, values.facilityId, budgetId);
    },
    options,
  );
}

export const replaceBudgetLinesSchema = z.object({
  ...baseSchema,
  budgetId: z.uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: budgetLinesSchema,
});

export type ReplaceBudgetLinesInput = z.input<typeof replaceBudgetLinesSchema>;

export async function replaceBudgetLines(
  input: ReplaceBudgetLinesInput,
  options: CommandOptions = {},
): Promise<BudgetResult> {
  const values = replaceBudgetLinesSchema.parse(input);
  const userId = actorId(values);
  assertUniqueLines(values.lines);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "replaceBudgetLines",
    async (tx) => {
      const rows = await tx
        .select({ id: budgets.id, status: budgets.status, version: budgets.version })
        .from(budgets)
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)))
        .limit(1);
      const budget = rows[0];
      if (!budget) throw new Error("Budget not found in this facility");
      if (budget.status !== "draft") {
        throw new Error("Only draft budgets can be revised");
      }

      await assertExpenseAccounts(
        tx,
        values.facilityId,
        values.lines.map((line) => line.accountId),
      );
      await assertLineDimensions(tx, values.facilityId, values.lines);

      await tx
        .delete(budgetLines)
        .where(
          and(
            eq(budgetLines.facilityId, values.facilityId),
            eq(budgetLines.budgetId, values.budgetId),
          ),
        );
      await insertLines(tx, values.budgetId, values.facilityId, userId, values.lines);
      await tx
        .update(budgets)
        .set({
          version: budget.version + 1,
          note: values.note?.trim() || null,
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)));

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "budget.revise",
        module: "finance",
        entity: "budgets",
        entityId: values.budgetId,
        details: { version: budget.version + 1, total: totalAmount(values.lines) },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return readBudgetResult(tx, values.facilityId, values.budgetId);
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Approval workflow                                                   */
/* ------------------------------------------------------------------ */

const budgetActionSchema = z.object({
  ...baseSchema,
  budgetId: z.uuid(),
});

export const submitBudgetSchema = budgetActionSchema;
export type SubmitBudgetInput = z.input<typeof submitBudgetSchema>;

export async function submitBudget(
  input: SubmitBudgetInput,
  options: CommandOptions = {},
): Promise<BudgetResult> {
  const values = submitBudgetSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "submitBudget",
    async (tx) => {
      const rows = await tx
        .select({ id: budgets.id, status: budgets.status })
        .from(budgets)
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)))
        .limit(1);
      const budget = rows[0];
      if (!budget) throw new Error("Budget not found in this facility");
      if (budget.status !== "draft" && budget.status !== "rejected") {
        throw new Error("Only draft or rejected budgets can be submitted");
      }
      const lines = await tx
        .select({ id: budgetLines.id })
        .from(budgetLines)
        .where(
          and(
            eq(budgetLines.facilityId, values.facilityId),
            eq(budgetLines.budgetId, values.budgetId),
          ),
        )
        .limit(1);
      if (!lines[0]) throw new Error("A budget needs at least one line before submission");

      await tx
        .update(budgets)
        .set({
          status: "submitted",
          submittedAt: new Date(),
          submittedBy: userId,
          rejectedReason: null,
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "budget.submit",
        module: "finance",
        entity: "budgets",
        entityId: values.budgetId,
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "budget.submitted",
        facilityId: values.facilityId,
        budgetId: values.budgetId,
      });
      return readBudgetResult(tx, values.facilityId, values.budgetId);
    },
    options,
  );
}

export const approveBudgetSchema = budgetActionSchema.extend({
  enforce: z.boolean().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type ApproveBudgetInput = z.input<typeof approveBudgetSchema>;

export async function approveBudget(
  input: ApproveBudgetInput,
  options: CommandOptions = {},
): Promise<BudgetResult> {
  const values = approveBudgetSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "approveBudget",
    async (tx) => {
      const rows = await tx
        .select({ id: budgets.id, status: budgets.status })
        .from(budgets)
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)))
        .limit(1);
      const budget = rows[0];
      if (!budget) throw new Error("Budget not found in this facility");
      if (budget.status !== "submitted") throw new Error("Only submitted budgets can be approved");

      await tx
        .update(budgets)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedBy: userId,
          enforce: values.enforce ?? true,
          note: values.note?.trim() || null,
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "budget.approve",
        module: "finance",
        entity: "budgets",
        entityId: values.budgetId,
        details: { enforce: values.enforce ?? true },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "budget.approved",
        facilityId: values.facilityId,
        budgetId: values.budgetId,
      });
      return readBudgetResult(tx, values.facilityId, values.budgetId);
    },
    options,
  );
}

export const rejectBudgetSchema = budgetActionSchema.extend({
  reason: z.string().trim().min(1, "A rejection reason is required").max(500),
});
export type RejectBudgetInput = z.input<typeof rejectBudgetSchema>;

export async function rejectBudget(
  input: RejectBudgetInput,
  options: CommandOptions = {},
): Promise<BudgetResult> {
  const values = rejectBudgetSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "rejectBudget",
    async (tx) => {
      const rows = await tx
        .select({ id: budgets.id, status: budgets.status })
        .from(budgets)
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)))
        .limit(1);
      if (!rows[0]) throw new Error("Budget not found in this facility");
      if (rows[0].status !== "submitted") throw new Error("Only submitted budgets can be rejected");

      await tx
        .update(budgets)
        .set({
          status: "rejected",
          rejectedReason: values.reason,
          approvedBy: null,
          approvedAt: null,
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "budget.reject",
        module: "finance",
        entity: "budgets",
        entityId: values.budgetId,
        details: { reason: values.reason },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return readBudgetResult(tx, values.facilityId, values.budgetId);
    },
    options,
  );
}

export const setBudgetEnforcementSchema = budgetActionSchema.extend({
  enforce: z.boolean(),
});
export type SetBudgetEnforcementInput = z.input<typeof setBudgetEnforcementSchema>;

export async function setBudgetEnforcement(
  input: SetBudgetEnforcementInput,
  options: CommandOptions = {},
): Promise<BudgetResult> {
  const values = setBudgetEnforcementSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setBudgetEnforcement",
    async (tx) => {
      const rows = await tx
        .select({ id: budgets.id, status: budgets.status })
        .from(budgets)
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)))
        .limit(1);
      if (!rows[0]) throw new Error("Budget not found in this facility");
      if (rows[0].status !== "approved") {
        throw new Error("Only approved budgets can change posting enforcement");
      }

      await tx
        .update(budgets)
        .set({ enforce: values.enforce, updatedBy: userId, updatedAt: new Date() })
        .where(and(eq(budgets.facilityId, values.facilityId), eq(budgets.id, values.budgetId)));
      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "budget.enforcement",
        module: "finance",
        entity: "budgets",
        entityId: values.budgetId,
        details: { enforce: values.enforce },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      return readBudgetResult(tx, values.facilityId, values.budgetId);
    },
    options,
  );
}
