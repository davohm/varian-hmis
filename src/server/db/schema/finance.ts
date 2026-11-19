import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { auditColumns, branches, facilities } from "./tenancy";

export const ledgerAccountTypeEnum = pgEnum("ledger_account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);

export const normalBalanceEnum = pgEnum("normal_balance", ["debit", "credit"]);

export const fiscalPeriodStatusEnum = pgEnum("fiscal_period_status", ["open", "closed"]);

export const journalStatusEnum = pgEnum("journal_status", ["posted", "reversed"]);

export const bankReconciliationStatusEnum = pgEnum("bank_reconciliation_status", [
  "open",
  "completed",
]);

/**
 * Chart of accounts. `system_role` lets automation (invoice revenue, payments)
 * resolve the correct account without hard-coding a code. At most one active
 * account per role per facility.
 */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 16 }).notNull(),
    name: text("name").notNull(),
    type: ledgerAccountTypeEnum("type").notNull(),
    normalBalance: normalBalanceEnum("normal_balance").notNull(),
    systemRole: varchar("system_role", { length: 32 }),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("ledger_accounts_facility_code_idx").on(
      table.facilityId,
      table.code,
    ),
    facilitySystemRoleIdx: uniqueIndex("ledger_accounts_facility_system_role_idx")
      .on(table.facilityId, table.systemRole)
      .where(sql`${table.systemRole} is not null`),
    facilityTypeIdx: index("ledger_accounts_facility_type_idx").on(
      table.facilityId,
      table.type,
    ),
  }),
);

export const costCenters = pgTable(
  "cost_centers",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityCodeIdx: uniqueIndex("cost_centers_facility_code_idx").on(
      table.facilityId,
      table.code,
    ),
    facilityIdx: index("cost_centers_facility_idx").on(table.facilityId),
  }),
);

/**
 * A fiscal period owns a date range. A journal can only post while the period
 * covering its date is open; closing is a one-way audited command.
 */
export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 64 }).notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    status: fiscalPeriodStatusEnum("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityNameIdx: uniqueIndex("fiscal_periods_facility_name_idx").on(
      table.facilityId,
      table.name,
    ),
    facilityRangeIdx: index("fiscal_periods_facility_range_idx").on(
      table.facilityId,
      table.startDate,
      table.endDate,
    ),
  }),
);

/**
 * Journal header. Posted entries are immutable apart from the reversible
 * status flag; the reversal is a separate entry that points back at the
 * original. Deletes are blocked in the database.
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    entryNo: varchar("entry_no", { length: 40 }).notNull(),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull().default("manual"),
    sourceId: text("source_id"),
    status: journalStatusEnum("status").notNull().default("posted"),
    reversedEntryId: uuid("reversed_entry_id").references(
      (): AnyPgColumn => journalEntries.id,
      { onDelete: "restrict" },
    ),
    reversalReason: text("reversal_reason"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    postedBy: text("posted_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityEntryNoIdx: uniqueIndex("journal_entries_facility_entry_no_idx").on(
      table.facilityId,
      table.entryNo,
    ),
    facilityDateIdx: index("journal_entries_facility_date_idx").on(
      table.facilityId,
      table.entryDate,
    ),
    periodIdx: index("journal_entries_period_idx").on(table.facilityId, table.periodId),
    sourceIdx: index("journal_entries_source_idx").on(
      table.facilityId,
      table.sourceType,
      table.sourceId,
    ),
    reversedIdx: index("journal_entries_reversed_idx").on(
      table.facilityId,
      table.reversedEntryId,
    ),
  }),
);

/** Append-only debit/credit lines. Trigger-blocked against update and delete. */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, {
      onDelete: "restrict",
    }),
    description: text("description"),
    debit: numeric("debit", { precision: 12, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 12, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entryLineIdx: uniqueIndex("journal_lines_entry_line_idx").on(table.entryId, table.lineNo),
    accountIdx: index("journal_lines_account_idx").on(table.facilityId, table.accountId),
    entryIdx: index("journal_lines_entry_idx").on(table.facilityId, table.entryId),
  }),
);

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: varchar("kind", { length: 32 }).notNull().default("bank"),
    accountNumber: varchar("account_number", { length: 64 }),
    currency: varchar("currency", { length: 8 }).notNull().default("KES"),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    openingBalance: numeric("opening_balance", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => ({
    facilityNameIdx: uniqueIndex("bank_accounts_facility_name_idx").on(
      table.facilityId,
      table.name,
    ),
    facilityIdx: index("bank_accounts_facility_idx").on(table.facilityId),
  }),
);

export const bankReconciliations = pgTable(
  "bank_reconciliations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    statementBalance: numeric("statement_balance", { precision: 12, scale: 2 }).notNull(),
    ledgerBalance: numeric("ledger_balance", { precision: 12, scale: 2 }).notNull(),
    difference: numeric("difference", { precision: 12, scale: 2 }).notNull(),
    status: bankReconciliationStatusEnum("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: text("completed_by"),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    accountPeriodIdx: index("bank_reconciliations_account_period_idx").on(
      table.facilityId,
      table.bankAccountId,
      table.periodStart,
    ),
  }),
);

/** Immutable bank movement rows; reconciliation marks them, never rewrites them. */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    reference: text("reference"),
    sourceType: varchar("source_type", { length: 32 }).notNull().default("manual"),
    sourceId: text("source_id"),
    reconciled: boolean("reconciled").notNull().default(false),
    reconciliationId: uuid("reconciliation_id").references(() => bankReconciliations.id, {
      onDelete: "restrict",
    }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountDateIdx: index("bank_transactions_account_date_idx").on(
      table.facilityId,
      table.bankAccountId,
      table.txnDate,
    ),
    reconciliationIdx: index("bank_transactions_reconciliation_idx").on(
      table.facilityId,
      table.reconciliationId,
    ),
  }),
);

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type CostCenter = typeof costCenters.$inferSelect;
export type NewCostCenter = typeof costCenters.$inferInsert;
export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type NewFiscalPeriod = typeof fiscalPeriods.$inferInsert;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;
export type BankReconciliation = typeof bankReconciliations.$inferSelect;
export type NewBankReconciliation = typeof bankReconciliations.$inferInsert;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
