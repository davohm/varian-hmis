import { and, asc, eq, exists, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

import { assertBalancedJournal, fiscalYearFor } from "@/lib/finance";
import { fromCents, toCents } from "@/lib/billing";
import { newId } from "@/lib/uuid";
import { recordAudit } from "@/server/audit";
import type { CommandTransaction } from "@/server/commands/run";
import {
  budgetLines,
  budgets,
  costCenters,
  facilities,
  fiscalPeriods,
  journalEntries,
  journalLines,
  ledgerAccounts,
} from "@/server/db/schema";
import { publishEvent } from "@/server/events";
import { nextFormattedNumber } from "@/server/numbering";

export interface PostingLineInput {
  accountId?: string;
  systemRole?: string;
  debit?: string | number;
  credit?: string | number;
  description?: string | null;
  costCenterId?: string | null;
}

export interface PostJournalInput {
  facilityId: string;
  entryDate: string;
  description: string;
  lines: PostingLineInput[];
  sourceType?: string;
  sourceId?: string | null;
  userId?: string | null;
  ip?: string | null;
  deviceId?: string | null;
}

export interface PostedJournal {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  debit: string;
  credit: string;
  lineCount: number;
}

/**
 * Resolve a ledger account by its stable system role. Automation never hard
 * codes a chart-of-accounts code, so each facility can keep its own numbering.
 */
export async function resolveSystemAccount(
  tx: CommandTransaction,
  facilityId: string,
  systemRole: string,
): Promise<{ id: string; code: string; name: string }> {
  const rows = await tx
    .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.facilityId, facilityId),
        eq(ledgerAccounts.systemRole, systemRole),
        eq(ledgerAccounts.active, true),
      ),
    )
    .limit(1);
  const account = rows[0];
  if (!account) {
    throw new Error(
      `No active ledger account is mapped to "${systemRole}". Configure the chart of accounts first.`,
    );
  }
  return account;
}

/**
 * Find the period that covers a date. If the facility has never opened a
 * period for that fiscal year, the calendar year is opened automatically so a
 * clinic cannot lose a day's takings because an accountant is on leave.
 */
export interface OpenPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

export async function ensureOpenPeriod(
  tx: CommandTransaction,
  facilityId: string,
  entryDate: string,
  userId?: string | null,
): Promise<OpenPeriod> {
  const covering = await tx
    .select({
      id: fiscalPeriods.id,
      name: fiscalPeriods.name,
      status: fiscalPeriods.status,
      startDate: fiscalPeriods.startDate,
      endDate: fiscalPeriods.endDate,
    })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.facilityId, facilityId),
        lte(fiscalPeriods.startDate, entryDate),
        gte(fiscalPeriods.endDate, entryDate),
      ),
    )
    .limit(1)
    .for("update");

  const period = covering[0];
  if (period) {
    if (period.status !== "open") {
      throw new Error(`Fiscal period ${period.name} is closed; post to an open period`);
    }
    return { id: period.id, name: period.name, startDate: period.startDate, endDate: period.endDate };
  }

  const year = fiscalYearFor(entryDate);
  const existing = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(
      and(eq(fiscalPeriods.facilityId, facilityId), eq(fiscalPeriods.name, year.name)),
    )
    .limit(1);
  if (existing[0]) {
    throw new Error(`No open fiscal period covers ${entryDate}`);
  }

  const id = newId();
  await tx.insert(fiscalPeriods).values({
    id,
    facilityId,
    name: year.name,
    startDate: year.startDate,
    endDate: year.endDate,
    status: "open",
    createdBy: userId ?? null,
  });
  return { id, name: year.name, startDate: year.startDate, endDate: year.endDate };
}

async function assertAccountsBelongToFacility(
  tx: CommandTransaction,
  facilityId: string,
  accountIds: string[],
) {
  if (accountIds.length === 0) return;
  const rows = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.facilityId, facilityId), inArray(ledgerAccounts.id, accountIds)),
    );
  if (rows.length !== new Set(accountIds).size) {
    throw new Error("Every journal line must reference an account in this facility");
  }
}

async function assertCostCentersBelongToFacility(
  tx: CommandTransaction,
  facilityId: string,
  costCenterIds: string[],
) {
  if (costCenterIds.length === 0) return;
  const rows = await tx
    .select({ id: costCenters.id })
    .from(costCenters)
    .where(and(eq(costCenters.facilityId, facilityId), inArray(costCenters.id, costCenterIds)));
  if (rows.length !== new Set(costCenterIds).size) {
    throw new Error("Every cost centre must belong to this facility");
  }
}

/**
 * Approved, enforced budgets are a hard posting control. A budget line only
 * applies when its account, cost centre and fiscal period match the posting;
 * facilities without a matching budget keep the previous unrestricted flow.
 */
export async function assertBudgetAvailability(
  tx: CommandTransaction,
  facilityId: string,
  period: OpenPeriod,
  lines: Array<{ accountId?: string | null; debit: string; costCenterId?: string | null }>,
) {
  const candidates = lines.filter(
    (line) => line.accountId && toCents(line.debit) > 0,
  ) as Array<{ accountId: string; debit: string; costCenterId?: string | null }>;
  if (candidates.length === 0) return;

  const accountRows = await tx
    .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, type: ledgerAccounts.type })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.facilityId, facilityId),
        inArray(
          ledgerAccounts.id,
          [...new Set(candidates.map((line) => line.accountId))],
        ),
      ),
    );
  const accountById = new Map(accountRows.map((account) => [account.id, account]));
  const expenseLines = candidates.filter((line) => accountById.get(line.accountId)?.type === "expense");
  if (expenseLines.length === 0) return;

  for (const line of expenseLines) {
    const budgetConditions: SQL[] = [
      eq(budgetLines.facilityId, facilityId),
      eq(budgetLines.accountId, line.accountId),
      eq(budgets.periodId, period.id),
      eq(budgets.status, "approved"),
      eq(budgets.enforce, true),
      sql`${budgetLines.costCenterId} is not distinct from ${line.costCenterId ?? null}`,
      sql`(${budgets.costCenterId} is null or ${budgets.costCenterId} = ${line.costCenterId ?? null})`,
      line.costCenterId
        ? sql`(${budgets.branchId} is null or ${exists(
            tx
              .select({ id: costCenters.id })
              .from(costCenters)
              .where(
                and(
                  eq(costCenters.facilityId, facilityId),
                  eq(costCenters.id, line.costCenterId),
                  eq(costCenters.branchId, budgets.branchId),
                ),
              ),
          )})`
        : isNull(budgets.branchId),
    ];
    const covering = await tx
      .select({ amount: budgetLines.amount })
      .from(budgetLines)
      .innerJoin(budgets, eq(budgetLines.budgetId, budgets.id))
      .where(and(...budgetConditions));
    if (covering.length === 0) continue;

    const budgetCents = covering.reduce((total, row) => total + toCents(row.amount), 0);
    const actualConditions = [
      eq(journalLines.facilityId, facilityId),
      eq(journalLines.accountId, line.accountId),
      gte(journalEntries.entryDate, period.startDate),
      lte(journalEntries.entryDate, period.endDate),
      line.costCenterId
        ? eq(journalLines.costCenterId, line.costCenterId)
        : isNull(journalLines.costCenterId),
    ];
    const actualRows = await tx
      .select({
        total: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...actualConditions));
    const actualCents = toCents(actualRows[0]?.total ?? 0);
    if (actualCents + toCents(line.debit) > budgetCents) {
      const account = accountById.get(line.accountId);
      throw new Error(
        `Posting would exceed the approved budget for ${account?.code ?? "this account"} in ${period.name}`,
      );
    }
  }
}

/**
 * The single posting path for automatic and manual journals. Callers own the
 * surrounding transaction, so a payment, its receipt and its journal commit or
 * roll back together.
 */
export async function postJournal(
  tx: CommandTransaction,
  input: PostJournalInput,
): Promise<PostedJournal> {
  const normalized = input.lines.map((line) => {
    if (!line.accountId && !line.systemRole) {
      throw new Error("Each journal line needs an account");
    }
    return {
      accountId: line.accountId,
      systemRole: line.systemRole,
      debit: fromCents(toCents(line.debit ?? 0)),
      credit: fromCents(toCents(line.credit ?? 0)),
      description: line.description?.trim() || null,
      costCenterId: line.costCenterId ?? null,
    };
  });

  const totals = assertBalancedJournal(normalized);

  const resolved: typeof normalized = [];
  for (const line of normalized) {
    const accountId =
      line.accountId ??
      (await resolveSystemAccount(tx, input.facilityId, line.systemRole as string)).id;
    resolved.push({ ...line, accountId });
  }

  await assertAccountsBelongToFacility(
    tx,
    input.facilityId,
    resolved.map((line) => line.accountId as string),
  );
  await assertCostCentersBelongToFacility(
    tx,
    input.facilityId,
    resolved
      .map((line) => line.costCenterId)
      .filter((value): value is string => Boolean(value)),
  );

  const period = await ensureOpenPeriod(tx, input.facilityId, input.entryDate, input.userId);
  await assertBudgetAvailability(tx, input.facilityId, period, resolved);

  const facilityRows = await tx
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, input.facilityId))
    .limit(1);
  const facility = facilityRows[0];
  if (!facility) throw new Error("Facility not found");

  const entryNo = await nextFormattedNumber(tx, facility, "journal");
  const entryId = newId();
  const description = input.description.trim();
  if (!description) throw new Error("A journal needs a description");

  await tx.insert(journalEntries).values({
    id: entryId,
    facilityId: input.facilityId,
    entryNo,
    entryDate: input.entryDate,
    periodId: period.id,
    description,
    sourceType: input.sourceType ?? "manual",
    sourceId: input.sourceId ?? null,
    status: "posted",
    postedBy: input.userId ?? null,
    createdBy: input.userId ?? null,
  });

  await tx.insert(journalLines).values(
    resolved.map((line, index) => ({
      id: newId(),
      facilityId: input.facilityId,
      entryId,
      lineNo: index + 1,
      accountId: line.accountId as string,
      costCenterId: line.costCenterId,
      description: line.description,
      debit: line.debit,
      credit: line.credit,
    })),
  );

  await recordAudit(tx, {
    facilityId: input.facilityId,
    userId: input.userId ?? null,
    action: "journal.post",
    module: "finance",
    entity: "journal_entries",
    entityId: entryId,
    details: {
      entryNo,
      entryDate: input.entryDate,
      period: period.name,
      sourceType: input.sourceType ?? "manual",
      sourceId: input.sourceId ?? null,
      debit: totals.debit,
      credit: totals.credit,
      lineCount: resolved.length,
    },
    ip: input.ip,
    deviceId: input.deviceId,
  });

  await publishEvent(tx, {
    type: "journal.posted",
    facilityId: input.facilityId,
    entryId,
    entryNo,
    entryDate: input.entryDate,
    sourceType: input.sourceType ?? "manual",
    amount: totals.debit,
  });

  return {
    entryId,
    entryNo,
    entryDate: input.entryDate,
    description,
    debit: totals.debit,
    credit: totals.credit,
    lineCount: resolved.length,
  };
}

/**
 * Post an automatic journal when the facility has a chart of accounts. Billing
 * and revenue automation call this so a clinic that has not configured finance
 * keeps working, while a configured facility always books the entry.
 */
export async function tryPostJournal(
  tx: CommandTransaction,
  input: PostJournalInput,
): Promise<PostedJournal | null> {
  const rows = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.facilityId, input.facilityId), eq(ledgerAccounts.active, true)))
    .limit(1);
  if (!rows[0]) return null;
  return postJournal(tx, input);
}

/** Signed balance of a ledger account from posted lines up to a date. */
export async function ledgerBalance(
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

/** Accounts ordered for a chart of accounts display. */
export async function listActiveAccounts(tx: CommandTransaction, facilityId: string) {
  return tx
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.facilityId, facilityId), eq(ledgerAccounts.active, true)))
    .orderBy(asc(ledgerAccounts.code));
}

/**
 * Reverse every posted journal that belongs to one business document. Voids and
 * payment reversals call this so the ledger keeps both the original entry and
 * its reversal, never an edit.
 */
export async function reverseJournalsForSource(
  tx: CommandTransaction,
  input: {
    facilityId: string;
    sourceType: string;
    sourceId: string;
    entryDate: string;
    reason: string;
    userId?: string | null;
    ip?: string | null;
    deviceId?: string | null;
  },
): Promise<string[]> {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.facilityId, input.facilityId),
        eq(journalEntries.sourceType, input.sourceType),
        eq(journalEntries.sourceId, input.sourceId),
        eq(journalEntries.status, "posted"),
        isNull(journalEntries.reversedEntryId),
      ),
    )
    .orderBy(asc(journalEntries.entryDate));

  const reversalNumbers: string[] = [];
  for (const entry of entries) {
    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, entry.id))
      .orderBy(asc(journalLines.lineNo));
    if (lines.length === 0) continue;

    const reversal = await postJournal(tx, {
      facilityId: input.facilityId,
      entryDate: input.entryDate,
      description: `Reversal of ${entry.entryNo}: ${input.reason}`,
      sourceType: "reversal",
      sourceId: entry.id,
      lines: lines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: line.description,
        costCenterId: line.costCenterId,
      })),
      userId: input.userId,
      ip: input.ip,
      deviceId: input.deviceId,
    });

    await tx
      .update(journalEntries)
      .set({
        status: "reversed",
        reversalReason: input.reason,
        reversedEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, entry.id));

    await tx
      .update(journalEntries)
      .set({ reversedEntryId: entry.id })
      .where(eq(journalEntries.id, reversal.entryId));

    reversalNumbers.push(reversal.entryNo);
  }

  return reversalNumbers;
}
