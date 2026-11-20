import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CHART_OF_ACCOUNTS } from "../src/lib/finance";
import { newIdempotencyKey } from "../src/lib/uuid";
import {
  approveBudget,
  createBudget,
  rejectBudget,
  replaceBudgetLines,
  setBudgetEnforcement,
  submitBudget,
} from "../src/server/commands/budgets";
import {
  createCostCenter,
  createLedgerAccount,
  openFiscalPeriod,
  postManualJournal,
} from "../src/server/commands/finance";
import { getBudgetDetail, listBudgetDetails } from "../src/server/queries/budgets";

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

const ACTOR = { userId: "vitest", deviceId: "budget-station" };
const PERIOD_START = "2200-01-01";
const PERIOD_END = "2200-12-31";
const ENTRY_DATE = "2200-06-15";

interface BudgetFixture {
  facility: { id: string; code: string };
  branchId: string;
  periodId: string;
  accounts: Record<string, string>;
  costCenterId: string;
  operationsCenterId: string;
}

async function withBudgetFacility<T>(run: (fixture: BudgetFixture) => Promise<T>): Promise<T> {
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
  const operations = await createCostCenter(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      code: "OPS",
      name: "Operations",
      branchId,
    },
    { database: ctx.db },
  );
  const period = await openFiscalPeriod(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      name: `BUD-${randomUUID().slice(0, 8).toUpperCase()}`,
      startDate: PERIOD_START,
      endDate: PERIOD_END,
    },
    { database: ctx.db },
  );

  try {
    return await run({
      facility,
      branchId,
      periodId: period.periodId,
      accounts,
      costCenterId: costCenter.costCenterId,
      operationsCenterId: operations.costCenterId,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

async function expectCommandError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error(`Expected the command to fail with ${pattern}`);
}

async function postExpense(
  fixture: BudgetFixture,
  amount: string,
  costCenterId: string | null = null,
  entryDate = ENTRY_DATE,
) {
  return postManualJournal(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      entryDate,
      description: `Budget test expense ${amount}`,
      lines: [
        {
          accountId: fixture.accounts["5000"],
          debit: amount,
          credit: 0,
          costCenterId,
        },
        { accountId: fixture.accounts.cash, debit: 0, credit: amount },
      ],
    },
    { database: ctx.db },
  );
}

async function createSimpleBudget(
  fixture: BudgetFixture,
  amount: string,
  options: { costCenterId?: string | null; branchId?: string | null; code?: string } = {},
) {
  return createBudget(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      code: options.code ?? `BUD${randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Operations expense plan",
      periodId: fixture.periodId,
      branchId: options.branchId ?? null,
      costCenterId: options.costCenterId ?? null,
      enforce: true,
      lines: [
        {
          accountId: fixture.accounts["5000"],
          costCenterId: options.costCenterId ?? null,
          amount,
        },
      ],
    },
    { database: ctx.db },
  );
}

describe("budgets and controls", () => {
  it("moves a draft through approval and enforces the approved amount at posting time", async () => {
    await withBudgetFacility(async (fixture) => {
      const budget = await createSimpleBudget(fixture, "1000.00");
      expect(budget.status).toBe("draft");
      expect(budget.version).toBe(1);
      expect(budget.total).toBe("1000.00");

      const initial = await getBudgetDetail(ctx.db, fixture.facility.id, budget.budgetId);
      expect(initial?.actual).toBe("0.00");
      expect(initial?.variance).toBe("1000.00");

      await submitBudget(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
        },
        { database: ctx.db },
      );
      await approveBudget(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
          enforce: true,
        },
        { database: ctx.db },
      );

      await postExpense(fixture, "400.00");
      const afterSpend = await getBudgetDetail(ctx.db, fixture.facility.id, budget.budgetId);
      expect(afterSpend?.actual).toBe("400.00");
      expect(afterSpend?.variance).toBe("600.00");

      await expectCommandError(postExpense(fixture, "700.00"), /exceed the approved budget/);

      await postExpense(fixture, "500.00");
      const withinBudget = await getBudgetDetail(ctx.db, fixture.facility.id, budget.budgetId);
      expect(withinBudget?.actual).toBe("900.00");
      expect(withinBudget?.variance).toBe("100.00");

      await setBudgetEnforcement(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
          enforce: false,
        },
        { database: ctx.db },
      );
      await postExpense(fixture, "700.00");
      const advisory = await getBudgetDetail(ctx.db, fixture.facility.id, budget.budgetId);
      expect(advisory?.enforce).toBe(false);
      expect(advisory?.actual).toBe("1600.00");
      expect(advisory?.variance).toBe("-600.00");
    });
  });

  it("applies only matching account, cost centre and branch budgets", async () => {
    await withBudgetFacility(async (fixture) => {
      const budget = await createSimpleBudget(fixture, "500.00", {
        branchId: fixture.branchId,
        costCenterId: fixture.costCenterId,
      });
      await submitBudget(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
        },
        { database: ctx.db },
      );
      await approveBudget(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
        },
        { database: ctx.db },
      );

      await postExpense(fixture, "400.00", fixture.costCenterId);
      await postExpense(fixture, "400.00", fixture.operationsCenterId);
      await expectCommandError(
        postExpense(fixture, "200.00", fixture.costCenterId),
        /exceed the approved budget/,
      );

      const detail = await getBudgetDetail(ctx.db, fixture.facility.id, budget.budgetId);
      expect(detail?.actual).toBe("400.00");
      expect(detail?.variance).toBe("100.00");
      expect(detail?.lines[0].costCenterCode).toBe("GEN");
    });
  });

  it("versions drafts and rejects invalid workflow transitions", async () => {
    await withBudgetFacility(async (fixture) => {
      const budget = await createSimpleBudget(fixture, "800.00");
      const revised = await replaceBudgetLines(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
          note: "Revised after review",
          lines: [{ accountId: fixture.accounts["5000"], amount: "1200.00" }],
        },
        { database: ctx.db },
      );
      expect(revised.version).toBe(2);
      expect(revised.total).toBe("1200.00");

      await submitBudget(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
        },
        { database: ctx.db },
      );
      await expectCommandError(
        replaceBudgetLines(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            budgetId: budget.budgetId,
            lines: [{ accountId: fixture.accounts["5000"], amount: "1500.00" }],
          },
          { database: ctx.db },
        ),
        /Only draft budgets can be revised/,
      );
      await expectCommandError(
        submitBudget(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            budgetId: budget.budgetId,
          },
          { database: ctx.db },
        ),
        /Only draft or rejected budgets can be submitted/,
      );

      await approveBudget(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          budgetId: budget.budgetId,
        },
        { database: ctx.db },
      );
      await expectCommandError(
        rejectBudget(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            budgetId: budget.budgetId,
            reason: "Too late",
          },
          { database: ctx.db },
        ),
        /Only submitted budgets can be rejected/,
      );

      const listed = await listBudgetDetails(ctx.db, fixture.facility.id, { status: "approved" });
      expect(listed.map((row) => row.code)).toContain(budget.code);
    });
  });

  it("replays an idempotent create with the same result", async () => {
    await withBudgetFacility(async (fixture) => {
      const idempotencyKey = newIdempotencyKey();
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey,
        actor: ACTOR,
        code: `IDEM${randomUUID().slice(0, 6).toUpperCase()}`,
        name: "Idempotent budget",
        periodId: fixture.periodId,
        lines: [{ accountId: fixture.accounts["5000"], amount: "250.00" }],
      };
      const first = await createBudget(input, { database: ctx.db });
      const second = await createBudget(input, { database: ctx.db });
      expect(second).toEqual(first);
    });
  });
});
