import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CHART_OF_ACCOUNTS,
  assertBalancedJournal,
  assertClaimTransition,
  canTransitionClaim,
  fiscalYearFor,
  journalTotals,
  normalBalanceFor,
} from "../src/lib/finance";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  closeFiscalPeriod,
  completeBankReconciliation,
  createBankAccount,
  createCostCenter,
  createLedgerAccount,
  openBankReconciliation,
  openFiscalPeriod,
  postManualJournal,
  recordBankTransaction,
  reverseJournal,
} from "../src/server/commands/finance";
import {
  createClaim,
  createPayer,
  createPayerContract,
  decidePreAuthorization,
  recordRemittance,
  requestPreAuthorization,
  transitionClaim,
} from "../src/server/commands/revenue";
import { encounters, invoices, patients, remittances } from "../src/server/db/schema";
import {
  getFinanceOverview,
  getGeneralLedger,
  getJournal,
  getTrialBalance,
  listFiscalPeriods,
  listLedgerAccounts,
} from "../src/server/queries/finance";
import {
  getClaim,
  getRevenueOverview,
  listClaims,
  listRevenueEncounters,
} from "../src/server/queries/revenue";

import {
  cleanupTestFacility,
  createTestDatabase,
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

const ACTOR = { userId: "vitest", deviceId: "finance-station" };
const ENTRY_DATE = "2026-03-15";

interface FinanceFixture {
  facility: { id: string; code: string };
  branchId: string;
  accounts: Record<string, string>;
  costCenterId: string;
}

/** Facility with the default chart of accounts and a General cost centre. */
async function withFinanceFacility<T>(
  run: (fixture: FinanceFixture) => Promise<T>,
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const accounts: Record<string, string> = {};

  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    const created = await createLedgerAccount(
      {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        code: account.code,
        name: account.name,
        type: account.type,
        systemRole: account.systemRole,
      },
      { database: ctx.db },
    );
    accounts[account.code] = created.accountId;
    if (account.systemRole) accounts[account.systemRole] = created.accountId;
  }

  const costCenter = await createCostCenter(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      code: "GEN",
      name: "General",
      branchId,
    },
    { database: ctx.db },
  );

  try {
    return await run({ facility, branchId, accounts, costCenterId: costCenter.costCenterId });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

function postSimpleJournal(
  facilityId: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: string,
  entryDate = ENTRY_DATE,
) {
  return postManualJournal(
    {
      facilityId,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      entryDate,
      description: "Test journal",
      lines: [
        { accountId: debitAccountId, debit: amount, credit: 0 },
        { accountId: creditAccountId, debit: 0, credit: amount },
      ],
    },
    { database: ctx.db },
  );
}

/** Drizzle wraps driver errors, so walk the cause chain for the database message. */
async function expectDatabaseError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(" | ")).toMatch(pattern);
    return;
  }
  throw new Error(`Expected the database to reject this query (${pattern})`);
}

/* ------------------------------------------------------------------ */
/* Pure rules                                                          */
/* ------------------------------------------------------------------ */
describe("finance rules", () => {
  it("assigns the natural balance for each account type", () => {
    expect(normalBalanceFor("asset")).toBe("debit");
    expect(normalBalanceFor("expense")).toBe("debit");
    expect(normalBalanceFor("liability")).toBe("credit");
    expect(normalBalanceFor("equity")).toBe("credit");
    expect(normalBalanceFor("revenue")).toBe("credit");
  });

  it("accepts only journals where debits equal credits", () => {
    expect(journalTotals([{ debit: "100.00", credit: 0 }, { debit: 0, credit: "100.00" }]).balanced).toBe(
      true,
    );
    expect(() =>
      assertBalancedJournal([
        { debit: "100.00", credit: 0 },
        { debit: 0, credit: "99.99" },
      ]),
    ).toThrow(/not balanced/i);
    expect(() =>
      assertBalancedJournal([
        { debit: "100.00", credit: "100.00" },
        { debit: "100.00", credit: 0 },
      ]),
    ).toThrow(/either a debit or a credit/i);
    expect(() =>
      assertBalancedJournal([{ debit: "100.00", credit: 0 }]),
    ).toThrow(/at least two lines/i);
  });

  it("enforces the claim lifecycle", () => {
    expect(canTransitionClaim("draft", "submitted")).toBe(true);
    expect(canTransitionClaim("draft", "paid")).toBe(false);
    expect(canTransitionClaim("submitted", "accepted")).toBe(true);
    expect(canTransitionClaim("paid", "closed")).toBe(true);
    expect(canTransitionClaim("closed", "submitted")).toBe(false);
    expect(() => assertClaimTransition("draft", "paid")).toThrow(/cannot move/i);
  });

  it("derives a calendar fiscal year", () => {
    expect(fiscalYearFor("2026-03-15")).toEqual({
      name: "FY 2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Journals                                                            */
/* ------------------------------------------------------------------ */

describe("journal posting", () => {
  it("posts a balanced journal, opens the period and proves the trial balance", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      const posted = await postSimpleJournal(
        facility.id,
        accounts.cash,
        accounts.service_revenue,
        "1500.00",
      );
      expect(posted.debit).toBe("1500.00");
      expect(posted.entryNo).toMatch(/-J-\d{2}-\d{6}$/);

      const periods = await listFiscalPeriods(ctx.db, facility.id);
      expect(periods).toHaveLength(1);
      expect(periods[0].name).toBe("FY 2026");
      expect(periods[0].status).toBe("open");

      const trial = await getTrialBalance(ctx.db, facility.id);
      expect(trial.balanced).toBe(true);
      expect(trial.debit).toBe("1500.00");
      expect(trial.credit).toBe("1500.00");

      const cashRow = trial.rows.find((row) => row.code === "1000");
      expect(cashRow?.balance).toBe("1500.00");

      const detail = await getJournal(ctx.db, facility.id, posted.entryId);
      expect(detail?.lines).toHaveLength(2);
      expect(detail?.lines[0].accountCode).toBe("1000");

      const overview = await getFinanceOverview(ctx.db, facility.id);
      expect(overview.cash).toBe("1500.00");
      expect(overview.revenue).toBe("1500.00");
      expect(overview.trialBalanceBalanced).toBe(true);
      expect(overview.hasChartOfAccounts).toBe(true);
    });
  });

  it("rejects an unbalanced journal before writing anything", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      await expect(
        postManualJournal(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            entryDate: ENTRY_DATE,
            description: "Broken journal",
            lines: [
              { accountId: accounts.cash, debit: "100.00", credit: 0 },
              { accountId: accounts.service_revenue, debit: 0, credit: "90.00" },
            ],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/not balanced/i);

      const trial = await getTrialBalance(ctx.db, facility.id);
      expect(trial.rows).toHaveLength(0);
    });
  });

  it("refuses new postings once the period is closed", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      await postSimpleJournal(facility.id, accounts.cash, accounts.service_revenue, "100.00");
      const [period] = await listFiscalPeriods(ctx.db, facility.id);

      const closed = await closeFiscalPeriod(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          periodId: period.id,
        },
        { database: ctx.db },
      );
      expect(closed.status).toBe("closed");

      await expect(
        postSimpleJournal(facility.id, accounts.cash, accounts.service_revenue, "50.00"),
      ).rejects.toThrow(/closed/i);
    });
  });

  it("mirrors a journal on reversal and keeps both entries immutable", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      const original = await postSimpleJournal(
        facility.id,
        accounts.cash,
        accounts.service_revenue,
        "400.00",
      );

      const reversal = await reverseJournal(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          entryId: original.entryId,
          entryDate: ENTRY_DATE,
          reason: "Typed the wrong amount",
        },
        { database: ctx.db },
      );
      expect(reversal.originalEntryNo).toBe(original.entryNo);
      expect(reversal.amount).toBe("400.00");

      const detail = await getJournal(ctx.db, facility.id, original.entryId);
      expect(detail?.status).toBe("reversed");
      expect(detail?.reversalReason).toBe("Typed the wrong amount");

      const trial = await getTrialBalance(ctx.db, facility.id);
      expect(trial.debit).toBe(trial.credit);
      const cash = trial.rows.find((row) => row.code === "1000");
      expect(cash?.balance).toBe("0.00");

      await expect(
        reverseJournal(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            entryId: original.entryId,
            entryDate: ENTRY_DATE,
            reason: "Again",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already been reversed/i);

      // The database itself refuses to rewrite a posted line.
      await expectDatabaseError(
        ctx.db.execute(sql`UPDATE journal_lines SET debit = 0 WHERE facility_id = ${facility.id}::uuid`),
        /append-only/i,
      );

      await expectDatabaseError(
        ctx.db.execute(sql`DELETE FROM journal_entries WHERE facility_id = ${facility.id}::uuid`),
        /cannot be deleted/i,
      );
    });
  });

  it("keeps every account in the facility chart", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      const other = await insertTestFacility(ctx.db);
      try {
        const foreign = await createLedgerAccount(
          {
            facilityId: other.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            code: "9000",
            name: "Foreign account",
            type: "expense",
          },
          { database: ctx.db },
        );

        await expect(
          postManualJournal(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              entryDate: ENTRY_DATE,
              description: "Cross-facility journal",
              lines: [
                { accountId: accounts.cash, debit: "10.00", credit: 0 },
                { accountId: foreign.accountId, debit: 0, credit: "10.00" },
              ],
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/in this facility/i);
      } finally {
        await cleanupTestFacility(ctx.db, other.id);
      }
    });
  });
});

/* ------------------------------------------------------------------ */
/* Fiscal periods and banking                                          */
/* ------------------------------------------------------------------ */

describe("fiscal periods", () => {
  it("rejects overlapping periods", async () => {
    await withFinanceFacility(async ({ facility }) => {
      await openFiscalPeriod(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          name: "H1 2026",
          startDate: "2026-01-01",
          endDate: "2026-06-30",
        },
        { database: ctx.db },
      );

      await expect(
        openFiscalPeriod(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            name: "Q1 2026",
            startDate: "2026-01-01",
            endDate: "2026-03-31",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/overlaps/i);
    });
  });
});

describe("bank reconciliation", () => {
  it("compares the statement with the ledger and flags the difference", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      const bank = await createBankAccount(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          name: "KCB Main",
          accountNumber: "1234567890",
          ledgerAccountId: accounts.bank,
          openingBalance: "0",
        },
        { database: ctx.db },
      );

      await postSimpleJournal(
        facility.id,
        accounts.bank,
        accounts.service_revenue,
        "2000.00",
      );

      await recordBankTransaction(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          bankAccountId: bank.bankAccountId,
          txnDate: ENTRY_DATE,
          description: "Patient deposit",
          direction: "in",
          amount: "2000.00",
          reference: "MPESA-1",
        },
        { database: ctx.db },
      );

      const opened = await openBankReconciliation(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          bankAccountId: bank.bankAccountId,
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          statementBalance: "2050.00",
        },
        { database: ctx.db },
      );
      expect(opened.ledgerBalance).toBe("2000.00");
      expect(opened.difference).toBe("50.00");

      const completed = await completeBankReconciliation(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          reconciliationId: opened.reconciliationId,
        },
        { database: ctx.db },
      );
      expect(completed.status).toBe("completed");
      expect(completed.reconciledTransactions).toBe(1);
      expect(completed.balanced).toBe(false);
    });
  });

  it("refuses a bank account posted to revenue", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      await expect(
        createBankAccount(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            name: "Wrong account",
            ledgerAccountId: accounts.service_revenue,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/asset ledger account/i);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Revenue cycle                                                       */
/* ------------------------------------------------------------------ */

interface RevenueFixture extends FinanceFixture {
  payerId: string;
  patientId: string;
  encounterId: string;
  invoiceId: string;
}

async function withRevenueFacility<T>(
  run: (fixture: RevenueFixture) => Promise<T>,
): Promise<T> {
  return withFinanceFacility(async (finance) => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const payer = await createPayer(
      {
        facilityId: finance.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        code: `INS-${suffix}`,
        name: `Jubilee Insurance ${suffix}`,
        kind: "insurer",
      },
      { database: ctx.db },
    );

    await createPayerContract(
      {
        facilityId: finance.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        payerId: payer.payerId,
        contractNo: `CT-${suffix}`,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      },
      { database: ctx.db },
    );

    const patientId = newId();
    await ctx.db.insert(patients).values({
      id: patientId,
      facilityId: finance.facility.id,
      mrn: `MRN-${suffix}`,
      firstName: "Amina",
      lastName: "Otieno",
      sex: "female",
      payerType: "insurance",
      createdBy: "vitest",
    });

    const encounterId = newId();
    await ctx.db.insert(encounters).values({
      id: encounterId,
      facilityId: finance.facility.id,
      branchId: finance.branchId,
      patientId,
      encounterNo: `ENC-${suffix}`,
      payerType: "insurance",
      createdBy: "vitest",
    });

    const invoiceId = newId();
    await ctx.db.insert(invoices).values({
      id: invoiceId,
      facilityId: finance.facility.id,
      encounterId,
      invoiceNo: `INV-${suffix}`,
      subtotal: "5000.00",
      total: "5000.00",
      paid: "0.00",
      status: "open",
      createdBy: "vitest",
    });

    return run({ ...finance, payerId: payer.payerId, patientId, encounterId, invoiceId });
  });
}

describe("revenue cycle", () => {
  it("moves a claim from draft to paid and books the receivable twice", async () => {
    await withRevenueFacility(async (fixture) => {
      const claim = await createClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          encounterId: fixture.encounterId,
          invoiceId: fixture.invoiceId,
          lines: [{ description: "Consultation", amount: "5000.00" }],
        },
        { database: ctx.db },
      );
      expect(claim.status).toBe("draft");
      expect(claim.total).toBe("5000.00");

      await transitionClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          claimId: claim.claimId,
          to: "submitted",
        },
        { database: ctx.db },
      );

      const submittedTrial = await getTrialBalance(ctx.db, fixture.facility.id);
      const insurance = submittedTrial.rows.find((row) => row.code === "1200");
      expect(insurance?.balance).toBe("5000.00");

      await transitionClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          claimId: claim.claimId,
          to: "accepted",
          approvedAmount: "5000.00",
        },
        { database: ctx.db },
      );

      const paid = await recordRemittance(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          claimId: claim.claimId,
          amount: "5000.00",
          reference: "REM-001",
        },
        { database: ctx.db },
      );
      expect(paid.status).toBe("paid");
      expect(paid.outstanding).toBe("0.00");
      expect(paid.journalEntryNo).toBeTruthy();

      const detail = await getClaim(ctx.db, fixture.facility.id, claim.claimId);
      expect(detail?.status).toBe("paid");
      expect(detail?.remittances).toHaveLength(1);

      const trial = await getTrialBalance(ctx.db, fixture.facility.id);
      expect(trial.balanced).toBe(true);
      const bank = trial.rows.find((row) => row.code === "1010");
      expect(bank?.balance).toBe("5000.00");
      const insuranceAfter = trial.rows.find((row) => row.code === "1200");
      expect(insuranceAfter?.balance ?? "0.00").toBe("0.00");

      const revenue = await getRevenueOverview(ctx.db, fixture.facility.id);
      expect(revenue.paidThisMonth).toBe("5000.00");
      expect(revenue.openClaims).toBe(0);
    });
  });

  it("rejects an illegal transition and an over-remittance", async () => {
    await withRevenueFacility(async (fixture) => {
      const claim = await createClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          encounterId: fixture.encounterId,
          lines: [{ description: "Ward bed", amount: "3000.00" }],
        },
        { database: ctx.db },
      );

      await expect(
        transitionClaim(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            claimId: claim.claimId,
            to: "paid",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/cannot move/i);

      await transitionClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          claimId: claim.claimId,
          to: "submitted",
        },
        { database: ctx.db },
      );

      await expect(
        recordRemittance(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            claimId: claim.claimId,
            amount: "3500.00",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/exceeds the outstanding/i);

      const listed = await listClaims(ctx.db, fixture.facility.id, { status: "submitted" });
      expect(listed).toHaveLength(1);
    });
  });

  it("records a pre-authorisation decision", async () => {
    await withRevenueFacility(async (fixture) => {
      const request = await requestPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          encounterId: fixture.encounterId,
          requestedAmount: "8000.00",
          reference: "AUTH-REQ-1",
        },
        { database: ctx.db },
      );
      expect(request.status).toBe("requested");
      expect(request.authNo).toMatch(/-PA-\d{2}-\d{6}$/);

      const decided = await decidePreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          preAuthId: request.preAuthId,
          decision: "approved",
          approvedAmount: "7500.00",
        },
        { database: ctx.db },
      );
      expect(decided.status).toBe("approved");
      expect(decided.approvedAmount).toBe("7500.00");
    });
  });

  it("never rewrites a remittance row", async () => {
    await withRevenueFacility(async (fixture) => {
      const claim = await createClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          encounterId: fixture.encounterId,
          lines: [{ description: "Theatre fee", amount: "2000.00" }],
        },
        { database: ctx.db },
      );
      await transitionClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          claimId: claim.claimId,
          to: "submitted",
        },
        { database: ctx.db },
      );
      await recordRemittance(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          claimId: claim.claimId,
          amount: "1000.00",
        },
        { database: ctx.db },
      );

      const [row] = await ctx.db
        .select({ id: remittances.id })
        .from(remittances)
        .where(eq(remittances.facilityId, fixture.facility.id));
      expect(row?.id).toBeTruthy();

      await expectDatabaseError(
        ctx.db.execute(
          sql`UPDATE remittances SET amount = 0 WHERE id = ${row.id}::uuid`,
        ),
        /append-only/i,
      );
    });
  });

  it("lists claim source encounters with patient and invoice context", async () => {
    await withRevenueFacility(async (fixture) => {
      const rows = await listRevenueEncounters(ctx.db, fixture.facility.id);
      const row = rows.find((item) => item.id === fixture.encounterId);
      expect(row).toMatchObject({
        patientId: fixture.patientId,
        patientName: "Amina Otieno",
        invoiceId: fixture.invoiceId,
      });
      expect(row?.mrn).toMatch(/^MRN-/);
      expect(row?.invoiceTotal).toBe("5000.00");
    });
  });

  it("lists the facility chart of accounts", async () => {
    await withFinanceFacility(async ({ facility }) => {
      const accounts = await listLedgerAccounts(ctx.db, facility.id);
      expect(accounts.length).toBe(DEFAULT_CHART_OF_ACCOUNTS.length);
      expect(accounts.some((account) => account.systemRole === "patient_receivable")).toBe(true);
    });
  });
});

describe("general ledger", () => {
  it("reports chronological activity with running balances and date filters", async () => {
    await withFinanceFacility(async ({ facility, accounts }) => {
      await postSimpleJournal(
        facility.id,
        accounts.cash,
        accounts.service_revenue,
        "100.00",
        "2026-03-10",
      );
      await postSimpleJournal(
        facility.id,
        accounts.cash,
        accounts.service_revenue,
        "250.00",
        "2026-03-15",
      );

      const ledger = await getGeneralLedger(ctx.db, facility.id, accounts.cash);
      expect(ledger?.account.code).toBe("1000");
      expect(ledger?.rows).toHaveLength(2);
      expect(ledger?.openingBalance).toBe("0.00");
      expect(ledger?.rows.map((row) => row.runningBalance)).toEqual(["100.00", "350.00"]);
      expect(ledger?.closingBalance).toBe("350.00");

      const march = await getGeneralLedger(ctx.db, facility.id, accounts.cash, {
        from: "2026-03-15",
      });
      expect(march?.openingBalance).toBe("100.00");
      expect(march?.rows).toHaveLength(1);
      expect(march?.closingBalance).toBe("350.00");
    });
  });
});
