import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { fromCents, toCents } from "@/lib/billing";
import {
  LEDGER_ACCOUNT_TYPES,
  normalBalanceFor,
  type LedgerAccountType,
} from "@/lib/finance";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import {
  bankAccounts,
  bankReconciliations,
  bankTransactions,
  costCenters,
  fiscalPeriods,
  journalEntries,
  journalLines,
  ledgerAccounts,
} from "@/server/db/schema";
import { postJournal } from "@/server/ledger";
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

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD)");

const money = z
  .union([z.string(), z.number()])
  .transform((value) => fromCents(toCents(value)));

/* ------------------------------------------------------------------ */
/* Chart of accounts                                                   */
/* ------------------------------------------------------------------ */

export const createLedgerAccountSchema = z.object({
  ...baseSchema,
  code: z
    .string()
    .trim()
    .min(1, "A code is required")
    .max(16, "Codes are at most 16 characters")
    .regex(/^[A-Za-z0-9.-]+$/, "Use letters, numbers, dots or dashes"),
  name: z.string().trim().min(1, "A name is required").max(200),
  type: z.enum(LEDGER_ACCOUNT_TYPES),
  systemRole: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/, "System roles are lowercase snake_case")
    .nullable()
    .optional(),
});

export type CreateLedgerAccountInput = z.input<typeof createLedgerAccountSchema>;
export interface LedgerAccountResult {
  accountId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  normalBalance: "debit" | "credit";
  systemRole: string | null;
}

export async function createLedgerAccount(
  input: CreateLedgerAccountInput,
  options: CommandOptions = {},
): Promise<LedgerAccountResult> {
  const values = createLedgerAccountSchema.parse(input);
  const userId = actorId(values);
  const code = values.code.toUpperCase();

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createLedgerAccount",
    async (tx) => {
      const duplicate = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.facilityId, values.facilityId), eq(ledgerAccounts.code, code)))
        .limit(1);
      if (duplicate[0]) throw new Error(`Account code ${code} already exists`);

      const normalBalance = normalBalanceFor(values.type);
      const accountId = newId();
      await tx.insert(ledgerAccounts).values({
        id: accountId,
        facilityId: values.facilityId,
        code,
        name: values.name,
        type: values.type,
        normalBalance,
        systemRole: values.systemRole ?? null,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "ledger_account.create",
        module: "finance",
        entity: "ledger_accounts",
        entityId: accountId,
        details: { code, name: values.name, type: values.type, systemRole: values.systemRole ?? null },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        accountId,
        code,
        name: values.name,
        type: values.type,
        normalBalance,
        systemRole: values.systemRole ?? null,
      };
    },
    options,
  );
}

export const updateLedgerAccountSchema = z.object({
  ...baseSchema,
  accountId: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  active: z.boolean().optional(),
  systemRole: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/)
    .nullable()
    .optional(),
});

export type UpdateLedgerAccountInput = z.input<typeof updateLedgerAccountSchema>;
export interface UpdateLedgerAccountResult {
  accountId: string;
  name: string;
  active: boolean;
  systemRole: string | null;
}

export async function updateLedgerAccount(
  input: UpdateLedgerAccountInput,
  options: CommandOptions = {},
): Promise<UpdateLedgerAccountResult> {
  const values = updateLedgerAccountSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateLedgerAccount",
    async (tx) => {
      const rows = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.id, values.accountId),
            eq(ledgerAccounts.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const account = rows[0];
      if (!account) throw new Error("Account not found in this facility");

      const nextSystemRole =
        values.systemRole === undefined ? account.systemRole : values.systemRole;
      const nextActive = values.active ?? account.active;
      if (account.active && !nextActive && nextSystemRole) {
        throw new Error(
          "Clear the system role or assign it to another account before deactivating this one",
        );
      }

      const name = values.name ?? account.name;
      const now = new Date();
      await tx
        .update(ledgerAccounts)
        .set({
          name,
          active: nextActive,
          systemRole: nextSystemRole,
          updatedAt: now,
          version: sql`${ledgerAccounts.version} + 1`,
        })
        .where(
          and(
            eq(ledgerAccounts.id, account.id),
            eq(ledgerAccounts.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "ledger_account.update",
        module: "finance",
        entity: "ledger_accounts",
        entityId: account.id,
        details: {
          before: { name: account.name, active: account.active, systemRole: account.systemRole },
          after: { name, active: nextActive, systemRole: nextSystemRole },
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { accountId: account.id, name, active: nextActive, systemRole: nextSystemRole };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Cost centres                                                        */
/* ------------------------------------------------------------------ */

export const createCostCenterSchema = z.object({
  ...baseSchema,
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9.-]+$/, "Use letters, numbers, dots or dashes"),
  name: z.string().trim().min(1).max(200),
  branchId: z.uuid().nullable().optional(),
});

export type CreateCostCenterInput = z.input<typeof createCostCenterSchema>;
export interface CostCenterResult {
  costCenterId: string;
  code: string;
  name: string;
}

export async function createCostCenter(
  input: CreateCostCenterInput,
  options: CommandOptions = {},
): Promise<CostCenterResult> {
  const values = createCostCenterSchema.parse(input);
  const userId = actorId(values);
  const code = values.code.toUpperCase();

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createCostCenter",
    async (tx) => {
      const duplicate = await tx
        .select({ id: costCenters.id })
        .from(costCenters)
        .where(and(eq(costCenters.facilityId, values.facilityId), eq(costCenters.code, code)))
        .limit(1);
      if (duplicate[0]) throw new Error(`Cost centre ${code} already exists`);

      const costCenterId = newId();
      await tx.insert(costCenters).values({
        id: costCenterId,
        facilityId: values.facilityId,
        branchId: values.branchId ?? null,
        code,
        name: values.name,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "cost_center.create",
        module: "finance",
        entity: "cost_centers",
        entityId: costCenterId,
        details: { code, name: values.name },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return { costCenterId, code, name: values.name };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Fiscal periods                                                      */
/* ------------------------------------------------------------------ */

export const openFiscalPeriodSchema = z.object({
  ...baseSchema,
  name: z.string().trim().min(1).max(64),
  startDate: isoDate,
  endDate: isoDate,
});

export type OpenFiscalPeriodInput = z.input<typeof openFiscalPeriodSchema>;
export interface FiscalPeriodResult {
  periodId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed";
}

export async function openFiscalPeriod(
  input: OpenFiscalPeriodInput,
  options: CommandOptions = {},
): Promise<FiscalPeriodResult> {
  const values = openFiscalPeriodSchema.parse(input);
  const userId = actorId(values);
  if (values.endDate < values.startDate) {
    throw new Error("The period end date must be on or after the start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "openFiscalPeriod",
    async (tx) => {
      const overlap = await tx
        .select({ id: fiscalPeriods.id, name: fiscalPeriods.name })
        .from(fiscalPeriods)
        .where(
          and(
            eq(fiscalPeriods.facilityId, values.facilityId),
            lte(fiscalPeriods.startDate, values.endDate),
            gte(fiscalPeriods.endDate, values.startDate),
          ),
        )
        .limit(1);
      if (overlap[0]) throw new Error(`This range overlaps fiscal period ${overlap[0].name}`);

      const periodId = newId();
      await tx.insert(fiscalPeriods).values({
        id: periodId,
        facilityId: values.facilityId,
        name: values.name,
        startDate: values.startDate,
        endDate: values.endDate,
        status: "open",
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "fiscal_period.open",
        module: "finance",
        entity: "fiscal_periods",
        entityId: periodId,
        details: { name: values.name, startDate: values.startDate, endDate: values.endDate },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        periodId,
        name: values.name,
        startDate: values.startDate,
        endDate: values.endDate,
        status: "open" as const,
      };
    },
    options,
  );
}

export const closeFiscalPeriodSchema = z.object({
  ...baseSchema,
  periodId: z.uuid(),
});

export type CloseFiscalPeriodInput = z.input<typeof closeFiscalPeriodSchema>;
export interface CloseFiscalPeriodResult {
  periodId: string;
  name: string;
  status: "closed";
  closedAt: string;
}

export async function closeFiscalPeriod(
  input: CloseFiscalPeriodInput,
  options: CommandOptions = {},
): Promise<CloseFiscalPeriodResult> {
  const values = closeFiscalPeriodSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "closeFiscalPeriod",
    async (tx) => {
      const rows = await tx
        .select()
        .from(fiscalPeriods)
        .where(
          and(
            eq(fiscalPeriods.id, values.periodId),
            eq(fiscalPeriods.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const period = rows[0];
      if (!period) throw new Error("Fiscal period not found in this facility");
      if (period.status === "closed") throw new Error(`${period.name} is already closed`);

      const now = new Date();
      await tx
        .update(fiscalPeriods)
        .set({
          status: "closed",
          closedAt: now,
          closedBy: userId,
          updatedAt: now,
          version: sql`${fiscalPeriods.version} + 1`,
        })
        .where(
          and(
            eq(fiscalPeriods.id, period.id),
            eq(fiscalPeriods.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "fiscal_period.close",
        module: "finance",
        entity: "fiscal_periods",
        entityId: period.id,
        details: { name: period.name, startDate: period.startDate, endDate: period.endDate },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "fiscal_period.closed",
        facilityId: values.facilityId,
        periodId: period.id,
        name: period.name,
      });

      return {
        periodId: period.id,
        name: period.name,
        status: "closed" as const,
        closedAt: now.toISOString(),
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Journals                                                            */
/* ------------------------------------------------------------------ */

export const journalLineSchema = z
  .object({
    accountId: z.uuid(),
    debit: money.default("0"),
    credit: money.default("0"),
    description: z.string().trim().max(500).nullable().optional(),
    costCenterId: z.uuid().nullable().optional(),
  })
  .refine((line) => toCents(line.debit) >= 0 && toCents(line.credit) >= 0, {
    message: "Journal amounts cannot be negative",
  });

export const postJournalSchema = z.object({
  ...baseSchema,
  entryDate: isoDate,
  description: z.string().trim().min(1, "A description is required").max(500),
  lines: z.array(journalLineSchema).min(2, "A journal needs at least two lines").max(50),
});

export type PostJournalCommandInput = z.input<typeof postJournalSchema>;
export interface JournalResult {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  debit: string;
  credit: string;
  lineCount: number;
}

export async function postManualJournal(
  input: PostJournalCommandInput,
  options: CommandOptions = {},
): Promise<JournalResult> {
  const values = postJournalSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "postManualJournal",
    async (tx) =>
      postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: values.entryDate,
        description: values.description,
        lines: values.lines,
        sourceType: "manual",
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      }),
    options,
  );
}

export const reverseJournalSchema = z.object({
  ...baseSchema,
  entryId: z.uuid(),
  entryDate: isoDate,
  reason: z.string().trim().min(1, "A reason is required to reverse a journal").max(500),
});

export type ReverseJournalInput = z.input<typeof reverseJournalSchema>;
export interface ReverseJournalResult {
  reversalEntryId: string;
  reversalEntryNo: string;
  originalEntryId: string;
  originalEntryNo: string;
  amount: string;
}

export async function reverseJournal(
  input: ReverseJournalInput,
  options: CommandOptions = {},
): Promise<ReverseJournalResult> {
  const values = reverseJournalSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "reverseJournal",
    async (tx) => {
      const rows = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, values.entryId),
            eq(journalEntries.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const entry = rows[0];
      if (!entry) throw new Error("Journal not found in this facility");
      if (entry.status === "reversed") throw new Error("This journal has already been reversed");
      if (entry.reversedEntryId) throw new Error("A reversal journal cannot be reversed");

      const lines = await tx
        .select()
        .from(journalLines)
        .where(
          and(
            eq(journalLines.entryId, entry.id),
            eq(journalLines.facilityId, values.facilityId),
          ),
        )
        .orderBy(asc(journalLines.lineNo));
      if (lines.length === 0) throw new Error("This journal has no lines to reverse");

      const reversal = await postJournal(tx, {
        facilityId: values.facilityId,
        entryDate: values.entryDate,
        description: `Reversal of ${entry.entryNo}: ${values.reason}`,
        sourceType: entry.sourceType,
        sourceId: entry.id,
        lines: lines.map((line) => ({
          accountId: line.accountId,
          debit: line.credit,
          credit: line.debit,
          description: line.description,
          costCenterId: line.costCenterId,
        })),
        userId,
        ip: values.actor.ip,
        deviceId: values.actor.deviceId,
      });

      const now = new Date();
      await tx
        .update(journalEntries)
        .set({
          status: "reversed",
          reversalReason: values.reason,
          updatedAt: now,
          version: sql`${journalEntries.version} + 1`,
        })
        .where(
          and(
            eq(journalEntries.id, entry.id),
            eq(journalEntries.facilityId, values.facilityId),
          ),
        );

      await tx
        .update(journalEntries)
        .set({ reversedEntryId: entry.id })
        .where(
          and(
            eq(journalEntries.id, reversal.entryId),
            eq(journalEntries.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "journal.reverse",
        module: "finance",
        entity: "journal_entries",
        entityId: entry.id,
        details: {
          originalEntryNo: entry.entryNo,
          reversalEntryNo: reversal.entryNo,
          amount: reversal.debit,
          reason: values.reason,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "journal.reversed",
        facilityId: values.facilityId,
        entryId: entry.id,
        entryNo: entry.entryNo,
        reversalEntryId: reversal.entryId,
        reversalEntryNo: reversal.entryNo,
      });

      return {
        reversalEntryId: reversal.entryId,
        reversalEntryNo: reversal.entryNo,
        originalEntryId: entry.id,
        originalEntryNo: entry.entryNo,
        amount: reversal.debit,
      };
    },
    options,
  );
}

/* ------------------------------------------------------------------ */
/* Banking                                                             */
/* ------------------------------------------------------------------ */

export const createBankAccountSchema = z.object({
  ...baseSchema,
  name: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(32).default("bank"),
  accountNumber: z.string().trim().max(64).nullable().optional(),
  currency: z.string().trim().min(3).max(8).default("KES"),
  ledgerAccountId: z.uuid(),
  openingBalance: money.default("0"),
});

export type CreateBankAccountInput = z.input<typeof createBankAccountSchema>;
export interface BankAccountResult {
  bankAccountId: string;
  name: string;
  currency: string;
  ledgerAccountId: string;
  openingBalance: string;
}

export async function createBankAccount(
  input: CreateBankAccountInput,
  options: CommandOptions = {},
): Promise<BankAccountResult> {
  const values = createBankAccountSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createBankAccount",
    async (tx) => {
      const accounts = await tx
        .select({ id: ledgerAccounts.id, type: ledgerAccounts.type })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.id, values.ledgerAccountId),
            eq(ledgerAccounts.facilityId, values.facilityId),
            eq(ledgerAccounts.active, true),
          ),
        )
        .limit(1);
      const account = accounts[0];
      if (!account) throw new Error("Ledger account not found in this facility");
      if (account.type !== "asset") {
        throw new Error("A bank account must post to an asset ledger account");
      }

      const duplicate = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(
          and(eq(bankAccounts.facilityId, values.facilityId), eq(bankAccounts.name, values.name)),
        )
        .limit(1);
      if (duplicate[0]) throw new Error(`A bank account named ${values.name} already exists`);

      const bankAccountId = newId();
      await tx.insert(bankAccounts).values({
        id: bankAccountId,
        facilityId: values.facilityId,
        name: values.name,
        kind: values.kind,
        accountNumber: values.accountNumber?.trim() || null,
        currency: values.currency.toUpperCase(),
        ledgerAccountId: values.ledgerAccountId,
        openingBalance: values.openingBalance,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "bank_account.create",
        module: "finance",
        entity: "bank_accounts",
        entityId: bankAccountId,
        details: {
          name: values.name,
          ledgerAccountId: values.ledgerAccountId,
          openingBalance: values.openingBalance,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        bankAccountId,
        name: values.name,
        currency: values.currency.toUpperCase(),
        ledgerAccountId: values.ledgerAccountId,
        openingBalance: values.openingBalance,
      };
    },
    options,
  );
}

export const recordBankTransactionSchema = z.object({
  ...baseSchema,
  bankAccountId: z.uuid(),
  txnDate: isoDate,
  description: z.string().trim().min(1).max(500),
  direction: z.enum(["in", "out"]),
  amount: z.union([z.string(), z.number()]).refine((value) => toCents(value) > 0, {
    message: "A bank transaction amount must be greater than zero",
  }),
  reference: z.string().trim().max(200).nullable().optional(),
  sourceType: z.string().trim().max(32).default("manual"),
  sourceId: z.string().trim().max(200).nullable().optional(),
});

export type RecordBankTransactionInput = z.input<typeof recordBankTransactionSchema>;
export interface BankTransactionResult {
  transactionId: string;
  bankAccountId: string;
  txnDate: string;
  amount: string;
  reconciled: boolean;
}

export async function recordBankTransaction(
  input: RecordBankTransactionInput,
  options: CommandOptions = {},
): Promise<BankTransactionResult> {
  const values = recordBankTransactionSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "recordBankTransaction",
    async (tx) => {
      const accounts = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.id, values.bankAccountId),
            eq(bankAccounts.facilityId, values.facilityId),
            eq(bankAccounts.active, true),
          ),
        )
        .limit(1);
      if (!accounts[0]) throw new Error("Bank account not found in this facility");

      const magnitude = toCents(values.amount);
      const amount = fromCents(values.direction === "out" ? -magnitude : magnitude);
      const transactionId = newId();
      await tx.insert(bankTransactions).values({
        id: transactionId,
        facilityId: values.facilityId,
        bankAccountId: values.bankAccountId,
        txnDate: values.txnDate,
        description: values.description,
        amount,
        reference: values.reference?.trim() || null,
        sourceType: values.sourceType,
        sourceId: values.sourceId ?? null,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "bank_transaction.create",
        module: "finance",
        entity: "bank_transactions",
        entityId: transactionId,
        details: {
          bankAccountId: values.bankAccountId,
          txnDate: values.txnDate,
          amount,
          direction: values.direction,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        transactionId,
        bankAccountId: values.bankAccountId,
        txnDate: values.txnDate,
        amount,
        reconciled: false,
      };
    },
    options,
  );
}

export const openBankReconciliationSchema = z.object({
  ...baseSchema,
  bankAccountId: z.uuid(),
  periodStart: isoDate,
  periodEnd: isoDate,
  statementBalance: money,
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type OpenBankReconciliationInput = z.input<typeof openBankReconciliationSchema>;
export interface BankReconciliationResult {
  reconciliationId: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  statementBalance: string;
  ledgerBalance: string;
  difference: string;
  status: "open" | "completed";
}

/** Ledger balance for a bank account's asset account up to a date. */
export async function balanceOfLedgerAccount(
  tx: CommandTransaction,
  facilityId: string,
  ledgerAccountId: string,
  asOf: string,
): Promise<string> {
  const rows = await tx
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalLines.facilityId, facilityId),
        eq(journalLines.accountId, ledgerAccountId),
        lte(journalEntries.entryDate, asOf),
      ),
    );
  const row = rows[0];
  return fromCents(toCents(row?.debit ?? 0) - toCents(row?.credit ?? 0));
}

export async function openBankReconciliation(
  input: OpenBankReconciliationInput,
  options: CommandOptions = {},
): Promise<BankReconciliationResult> {
  const values = openBankReconciliationSchema.parse(input);
  const userId = actorId(values);
  if (values.periodEnd < values.periodStart) {
    throw new Error("The reconciliation end date must be on or after the start date");
  }

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "openBankReconciliation",
    async (tx) => {
      const rows = await tx
        .select()
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.id, values.bankAccountId),
            eq(bankAccounts.facilityId, values.facilityId),
          ),
        )
        .limit(1);
      const account = rows[0];
      if (!account) throw new Error("Bank account not found in this facility");

      const ledgerBalance = await balanceOfLedgerAccount(
        tx,
        values.facilityId,
        account.ledgerAccountId,
        values.periodEnd,
      );
      const difference = fromCents(toCents(values.statementBalance) - toCents(ledgerBalance));

      const reconciliationId = newId();
      await tx.insert(bankReconciliations).values({
        id: reconciliationId,
        facilityId: values.facilityId,
        bankAccountId: account.id,
        periodStart: values.periodStart,
        periodEnd: values.periodEnd,
        statementBalance: values.statementBalance,
        ledgerBalance,
        difference,
        status: "open",
        note: values.note?.trim() || null,
        createdBy: userId,
      });

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "bank_reconciliation.open",
        module: "finance",
        entity: "bank_reconciliations",
        entityId: reconciliationId,
        details: {
          bankAccountId: account.id,
          periodStart: values.periodStart,
          periodEnd: values.periodEnd,
          statementBalance: values.statementBalance,
          ledgerBalance,
          difference,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });

      return {
        reconciliationId,
        bankAccountId: account.id,
        periodStart: values.periodStart,
        periodEnd: values.periodEnd,
        statementBalance: values.statementBalance,
        ledgerBalance,
        difference,
        status: "open" as const,
      };
    },
    options,
  );
}

export const completeBankReconciliationSchema = z.object({
  ...baseSchema,
  reconciliationId: z.uuid(),
  note: z.string().trim().max(1_000).nullable().optional(),
});

export type CompleteBankReconciliationInput = z.input<typeof completeBankReconciliationSchema>;
export interface CompleteBankReconciliationResult {
  reconciliationId: string;
  status: "completed";
  reconciledTransactions: number;
  difference: string;
  balanced: boolean;
}

export async function completeBankReconciliation(
  input: CompleteBankReconciliationInput,
  options: CommandOptions = {},
): Promise<CompleteBankReconciliationResult> {
  const values = completeBankReconciliationSchema.parse(input);
  const userId = actorId(values);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "completeBankReconciliation",
    async (tx) => {
      const rows = await tx
        .select()
        .from(bankReconciliations)
        .where(
          and(
            eq(bankReconciliations.id, values.reconciliationId),
            eq(bankReconciliations.facilityId, values.facilityId),
          ),
        )
        .limit(1)
        .for("update");
      const reconciliation = rows[0];
      if (!reconciliation) throw new Error("Reconciliation not found in this facility");
      if (reconciliation.status === "completed") {
        throw new Error("This reconciliation is already completed");
      }

      const now = new Date();
      const updated = await tx
        .update(bankTransactions)
        .set({ reconciled: true, reconciliationId: reconciliation.id })
        .where(
          and(
            eq(bankTransactions.facilityId, values.facilityId),
            eq(bankTransactions.bankAccountId, reconciliation.bankAccountId),
            gte(bankTransactions.txnDate, reconciliation.periodStart),
            lte(bankTransactions.txnDate, reconciliation.periodEnd),
            eq(bankTransactions.reconciled, false),
          ),
        )
        .returning({ id: bankTransactions.id });

      await tx
        .update(bankReconciliations)
        .set({
          status: "completed",
          completedAt: now,
          completedBy: userId,
          note: values.note?.trim() || reconciliation.note,
          updatedAt: now,
          version: sql`${bankReconciliations.version} + 1`,
        })
        .where(
          and(
            eq(bankReconciliations.id, reconciliation.id),
            eq(bankReconciliations.facilityId, values.facilityId),
          ),
        );

      await recordAudit(tx, {
        facilityId: values.facilityId,
        userId,
        action: "bank_reconciliation.complete",
        module: "finance",
        entity: "bank_reconciliations",
        entityId: reconciliation.id,
        details: {
          bankAccountId: reconciliation.bankAccountId,
          difference: reconciliation.difference,
          reconciledTransactions: updated.length,
        },
        deviceId: values.actor.deviceId,
        ip: values.actor.ip,
      });
      await publishEvent(tx, {
        type: "bank_reconciliation.completed",
        facilityId: values.facilityId,
        reconciliationId: reconciliation.id,
        difference: reconciliation.difference,
      });

      return {
        reconciliationId: reconciliation.id,
        status: "completed" as const,
        reconciledTransactions: updated.length,
        difference: reconciliation.difference,
        balanced: toCents(reconciliation.difference) === 0,
      };
    },
    options,
  );
}

