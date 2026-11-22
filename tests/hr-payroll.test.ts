import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CHART_OF_ACCOUNTS } from "../src/lib/finance";
import { newIdempotencyKey } from "../src/lib/uuid";
import {
  createCostCenter,
  createLedgerAccount,
  setFinanceApprovalLimit,
} from "../src/server/commands/finance";
import {
  assignShift,
  createEmployee,
  createEmploymentContract,
  createPosition,
  createShiftTemplate,
  decideLeave,
  recordAttendance,
  requestLeave,
} from "../src/server/commands/hr";
import {
  approvePayrollRun,
  createPayrollRun,
  postPayrollRun,
} from "../src/server/commands/payroll";
import {
  attendanceRecords,
  auditLog,
  employees,
  employmentContracts,
  journalEntries,
  journalLines,
  ledgerAccounts,
  leaveRequests,
  payrollLines,
  payrollRunApprovals,
  payslips,
  staffRoleScopes,
  statutoryRates,
  syncOutbox,
  user,
} from "../src/server/db/schema";
import { getPayrollOverview, getPayrollRun } from "../src/server/queries/payroll";
import {
  cleanupTestFacility,
  createTestDatabase,
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

interface Actor {
  userId: string;
  deviceId: string;
  ip: string;
}

type HrPayrollRole = "admin" | "hr_officer" | "payroll_officer" | "auditor";

function actorOf(userId: string, label: string): Actor {
  return { userId, deviceId: `hr-payroll-${label}`, ip: "127.0.0.1" };
}

async function insertRoleActor(
  facilityId: string,
  role: HrPayrollRole,
  label: string,
): Promise<Actor> {
  const userId = await insertTestActor(ctx.db);
  if (role !== "admin") {
    await ctx.db.update(user).set({ role: "user" }).where(eq(user.id, userId));
  }
  await ctx.db.insert(staffRoleScopes).values({ userId, role, facilityId });
  return actorOf(userId, label);
}

/** Drizzle wraps driver errors, so walk the cause chain for the database message. */
async function expectDatabaseError(promise: PromiseLike<unknown>, pattern: RegExp) {
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
  throw new Error(`Expected database error matching ${pattern.toString()}`);
}

interface HrPayrollFixture {
  facility: { id: string; code: string };
  branchId: string;
  costCenterId: string;
  admin: Actor;
  hr: Actor;
  preparer: Actor;
  approver: Actor;
  suffix: string;
}

async function withFixture<T>(
  options: { rates?: boolean } ,
  run: (fixture: HrPayrollFixture) => Promise<T>,
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  try {
    const branchId = await insertTestBranch(ctx.db, facility.id);
    const admin = await insertRoleActor(facility.id, "admin", "admin");
    const hr = await insertRoleActor(facility.id, "hr_officer", "hr");
    const preparer = await insertRoleActor(facility.id, "payroll_officer", "preparer");
    const approver = await insertRoleActor(facility.id, "payroll_officer", "approver");

    for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
      await createLedgerAccount(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: admin,
          code: account.code,
          name: account.name,
          type: account.type,
          systemRole: account.systemRole,
        },
        { database: ctx.db },
      );
    }

    const costCenter = await createCostCenter(
      {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: admin,
        code: "GEN",
        name: "General",
        branchId,
      },
      { database: ctx.db },
    );

    if (options.rates) {
      // Explicit test-only fixture rates. These are not statutory guidance and
      // are never evidence of a real payroll configuration.
      await ctx.db.insert(statutoryRates).values([
        {
          facilityId: facility.id,
          rateType: "paye_band",
          bandOrder: 1,
          lowerBound: "0.00",
          upperBound: null,
          ratePercent: "10.000",
          fixedAmount: "0.00",
          effectiveFrom: "2026-01-01",
          legalReference: "TEST ONLY - unit fixture, not compliance evidence",
          createdBy: "vitest-hr-payroll",
        },
        {
          facilityId: facility.id,
          rateType: "nssf_tier",
          bandOrder: 1,
          lowerBound: "0.00",
          upperBound: null,
          ratePercent: "5.000",
          fixedAmount: "0.00",
          effectiveFrom: "2026-01-01",
          legalReference: "TEST ONLY - unit fixture, not compliance evidence",
          createdBy: "vitest-hr-payroll",
        },
        {
          facilityId: facility.id,
          rateType: "nssf_employer",
          bandOrder: 1,
          lowerBound: "0.00",
          upperBound: null,
          ratePercent: "5.000",
          fixedAmount: "0.00",
          effectiveFrom: "2026-01-01",
          legalReference: "TEST ONLY - unit fixture, not compliance evidence",
          createdBy: "vitest-hr-payroll",
        },
        {
          facilityId: facility.id,
          rateType: "shif",
          bandOrder: 1,
          lowerBound: "0.00",
          upperBound: null,
          ratePercent: "0.000",
          fixedAmount: "1000.00",
          effectiveFrom: "2026-01-01",
          legalReference: "TEST ONLY - unit fixture, not compliance evidence",
          createdBy: "vitest-hr-payroll",
        },
        {
          facilityId: facility.id,
          rateType: "housing_levy",
          bandOrder: 1,
          lowerBound: "0.00",
          upperBound: null,
          ratePercent: "1.500",
          fixedAmount: "0.00",
          effectiveFrom: "2026-01-01",
          legalReference: "TEST ONLY - unit fixture, not compliance evidence",
          createdBy: "vitest-hr-payroll",
        },
      ]);
    }

    return await run({
      facility,
      branchId,
      costCenterId: costCenter.costCenterId,
      admin,
      hr,
      preparer,
      approver,
      suffix: randomUUID().slice(0, 8),
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

async function seedEmployee(
  fixture: HrPayrollFixture,
  actor: Actor,
  label: string,
  basicSalary: string,
) {
  const position = await createPosition(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor,
      code: `POS-${label}-${fixture.suffix}`.toUpperCase(),
      title: `${label} Officer`,
    },
    { database: ctx.db },
  );
  const employee = await createEmployee(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor,
      firstName: label,
      lastName: "Test",
      dateOfJoining: "2026-01-01",
    },
    { database: ctx.db },
  );
  const contract = await createEmploymentContract(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor,
      employeeId: employee.employeeId,
      positionId: position.positionId,
      contractType: "permanent",
      startDate: "2026-01-01",
      basicSalary,
    },
    { database: ctx.db },
  );
  return { position, employee, contract };
}

describe("HR and payroll", () => {
  it("keeps personnel records audited and separates leave requester from decider", async () => {
    await withFixture({ rates: false }, async (fixture) => {
      const person = await seedEmployee(fixture, fixture.hr, "Ann", "100000.00");

      const superseding = await createEmploymentContract(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.hr,
          employeeId: person.employee.employeeId,
          positionId: person.position.positionId,
          contractType: "permanent",
          startDate: "2026-02-01",
          basicSalary: "120000.00",
        },
        { database: ctx.db },
      );
      const contracts = await ctx.db
        .select()
        .from(employmentContracts)
        .where(eq(employmentContracts.facilityId, fixture.facility.id));
      expect(contracts).toHaveLength(2);
      expect(contracts.filter((contract) => contract.active)).toHaveLength(1);
      expect(contracts.find((contract) => contract.active)?.id).toBe(superseding.contractId);

      const shift = await createShiftTemplate(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.hr,
          code: "DAY",
          name: "Day shift",
          startTime: "08:00",
          endTime: "17:00",
        },
        { database: ctx.db },
      );
      await assignShift(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.hr,
          employeeId: person.employee.employeeId,
          shiftTemplateId: shift.shiftTemplateId,
          assignedDate: "2026-01-15",
        },
        { database: ctx.db },
      );
      await recordAttendance(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.hr,
          employeeId: person.employee.employeeId,
          workDate: "2026-01-15",
          status: "absent",
          hoursWorked: 8,
          note: "No show",
        },
        { database: ctx.db },
      );
      const attendance = await ctx.db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.facilityId, fixture.facility.id));
      expect(attendance).toHaveLength(1);
      expect(attendance[0]?.hoursWorked).toBe("0.00");
      expect(attendance[0]?.shiftAssignmentId).toBeTruthy();

      const leave = await requestLeave(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.hr,
          employeeId: person.employee.employeeId,
          leaveType: "annual",
          startDate: "2026-03-02",
          endDate: "2026-03-04",
          reason: "Annual leave",
        },
        { database: ctx.db },
      );
      expect(leave.days).toBe(3);

      await expect(
        decideLeave(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.hr,
            leaveRequestId: leave.leaveRequestId,
            decision: "approved",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot decide their own leave request/i);

      await decideLeave(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          leaveRequestId: leave.leaveRequestId,
          decision: "approved",
        },
        { database: ctx.db },
      );
      const decided = await ctx.db
        .select()
        .from(leaveRequests)
        .where(eq(leaveRequests.id, leave.leaveRequestId));
      expect(decided[0]?.status).toBe("approved");
      expect(decided[0]?.decidedBy).toBe(fixture.preparer.userId);

      await expect(
        requestLeave(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.hr,
            employeeId: person.employee.employeeId,
            leaveType: "sick",
            startDate: "2026-03-03",
            endDate: "2026-03-03",
            reason: "Overlaps approved leave",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already has approved leave/i);

      const rejection = await requestLeave(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.hr,
          employeeId: person.employee.employeeId,
          leaveType: "sick",
          startDate: "2026-04-06",
          endDate: "2026-04-07",
          reason: "Unwell",
        },
        { database: ctx.db },
      );
      await expect(
        decideLeave(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.approver,
            leaveRequestId: rejection.leaveRequestId,
            decision: "rejected",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/reason is required to reject leave/i);
      await decideLeave(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.approver,
          leaveRequestId: rejection.leaveRequestId,
          decision: "rejected",
          reason: "Insufficient evidence",
        },
        { database: ctx.db },
      );

      await expectDatabaseError(
        ctx.db.delete(employees).where(eq(employees.id, person.employee.employeeId)),
        /cannot be hard-deleted/i,
      );

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.facilityId, fixture.facility.id));
      expect(audits.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "hr.employee.create",
          "hr.contract.create",
          "hr.shift.assign",
          "hr.attendance.record",
          "hr.leave.request",
          "hr.leave.decide",
        ]),
      );
    });
  });

  it("computes from admin rates, enforces SoD and the approval ceiling, then posts a balanced run", async () => {
    await withFixture({ rates: true }, async (fixture) => {
      const ann = await seedEmployee(fixture, fixture.hr, "Ann", "100000.00");
      await seedEmployee(fixture, fixture.hr, "Ben", "50000.00");

      const run = await createPayrollRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          allocations: [
            {
              employeeId: ann.employee.employeeId,
              costCenterId: fixture.costCenterId,
              allowances: "10000.00",
            },
          ],
        },
        { database: ctx.db },
      );
      expect(run.employeeCount).toBe(2);
      expect(run.totalGross).toBe("160000.00");
      expect(run.totalNet).toBe("131600.00");
      expect(run.missingRateTypes).toEqual([]);
      expect(run.runNo).toMatch(/PAY-\d{2}-\d{6}$/);

      await expect(
        createPayrollRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            periodStart: "2026-01-01",
            periodEnd: "2026-01-31",
          },
          { database: ctx.db },
        ),
      ).resolves.toMatchObject({ runNo: expect.stringMatching(/-000002$/) });

      await expect(
        approvePayrollRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.preparer,
            runId: run.runId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot approve their own payroll run/i);

      await setFinanceApprovalLimit(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.admin,
          action: "approvePayrollRun",
          role: "payroll_officer",
          maxAmount: "100000.00",
        },
        { database: ctx.db },
      );

      await expect(
        approvePayrollRun(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: fixture.approver,
            runId: run.runId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/exceeds your approval limit/i);

      await setFinanceApprovalLimit(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.admin,
          action: "approvePayrollRun",
          role: "payroll_officer",
          maxAmount: "200000.00",
        },
        { database: ctx.db },
      );
      const approval = await approvePayrollRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.approver,
          runId: run.runId,
          reason: "Within delegated authority",
        },
        { database: ctx.db },
      );
      expect(approval).toMatchObject({ status: "approved", approvalRole: "payroll_officer" });

      const posted = await postPayrollRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.admin,
          runId: run.runId,
        },
        { database: ctx.db },
      );
      expect(posted.slipCount).toBe(2);
      expect(posted.entryNo).toMatch(/-J-\d{2}-\d{6}$/);

      const detail = await getPayrollRun(ctx.db, fixture.facility.id, run.runId);
      expect(detail?.status).toBe("posted");
      expect(detail?.lines).toHaveLength(2);
      expect(detail?.payslips).toHaveLength(2);
      expect(detail?.payslips.every((slip) => /PSL-\d{2}-\d{6}$/.test(slip.slipNo))).toBe(true);
      const annLine = detail?.lines.find((line) => line.employeeId === ann.employee.employeeId);
      expect(annLine).toMatchObject({
        grossPay: "110000.00",
        paye: "11000.00",
        nssfEmployee: "5500.00",
        nssfEmployer: "5500.00",
        shif: "1000.00",
        housingLevy: "1650.00",
        netPay: "90850.00",
      });
      expect(annLine?.missingRateTypes).toEqual([]);

      const journal = await ctx.db
        .select({
          systemRole: ledgerAccounts.systemRole,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(ledgerAccounts, eq(journalLines.accountId, ledgerAccounts.id))
        .where(eq(journalLines.entryId, posted.entryId));
      const totals = new Map<string, { debit: number; credit: number }>();
      for (const line of journal) {
        const role = line.systemRole ?? "unmapped";
        const current = totals.get(role) ?? { debit: 0, credit: 0 };
        current.debit += Number(line.debit);
        current.credit += Number(line.credit);
        totals.set(role, current);
      }
      expect(totals.get("salaries_expense")?.debit).toBe(160000);
      expect(totals.get("nssf_expense")?.debit).toBe(8000);
      expect(totals.get("payroll_payable")?.credit).toBe(131600);
      expect(totals.get("paye_payable")?.credit).toBe(16000);
      expect(totals.get("nssf_payable")?.credit).toBe(16000);
      expect(totals.get("shif_payable")?.credit).toBe(2000);
      expect(totals.get("housing_levy_payable")?.credit).toBe(2400);
      const allDebits = journal.reduce((sum, line) => sum + Number(line.debit), 0);
      const allCredits = journal.reduce((sum, line) => sum + Number(line.credit), 0);
      expect(allDebits).toBe(allCredits);
      expect(allDebits).toBe(168000);

      const overview = await getPayrollOverview(ctx.db, fixture.facility.id);
      expect(overview).toMatchObject({
        postedRuns: 1,
        lastNetPay: "131600.00",
        activeEmployees: 2,
        missingRateTypes: [],
      });

      const actions = (
        await ctx.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.facilityId, fixture.facility.id))
      ).map((row) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "payroll.run.create",
          "payroll.run.approve",
          "payroll.run.post",
          "finance_approval_limit.set",
        ]),
      );
      const outbox = await ctx.db
        .select()
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.facilityId, fixture.facility.id),
            eq(syncOutbox.tableName, "payroll_runs"),
            eq(syncOutbox.recordId, run.runId),
          ),
        );
      expect(outbox.length).toBeGreaterThan(0);

      await expectDatabaseError(
        ctx.db
          .update(payrollLines)
          .set({ netPay: "1.00" })
          .where(eq(payrollLines.runId, run.runId)),
        /append-only/i,
      );
      await expectDatabaseError(
        ctx.db.update(payslips).set({ slipNo: "CHANGED" }).where(eq(payslips.runId, run.runId)),
        /append-only/i,
      );
      await expectDatabaseError(
        ctx.db
          .delete(payrollRunApprovals)
          .where(eq(payrollRunApprovals.runId, run.runId)),
        /append-only/i,
      );

      const entries = await ctx.db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.facilityId, fixture.facility.id));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sourceType).toBe("payroll");
    });
  });

  it("computes zero deductions with warnings when rates are unset or test-only", async () => {
    await withFixture({ rates: false }, async (fixture) => {
      const person = await seedEmployee(fixture, fixture.hr, "Cara", "100000.00");
      await ctx.db.insert(statutoryRates).values({
        facilityId: fixture.facility.id,
        rateType: "test_placeholder_statutory_rate",
        bandOrder: 1,
        lowerBound: "0.00",
        upperBound: null,
        ratePercent: "99.000",
        fixedAmount: "0.00",
        effectiveFrom: "2026-01-01",
        legalReference: "TEST ONLY - never statutory evidence",
        createdBy: "vitest-hr-payroll",
      });

      const run = await createPayrollRun(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: fixture.preparer,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
        },
        { database: ctx.db },
      );
      expect(run.missingRateTypes.sort()).toEqual(
        ["housing_levy", "nssf_employer", "nssf_tier", "paye_band", "shif"].sort(),
      );
      expect(run.totalNet).toBe("100000.00");

      const detail = await getPayrollRun(ctx.db, fixture.facility.id, run.runId);
      const line = detail?.lines.find((item) => item.employeeId === person.employee.employeeId);
      expect(line).toMatchObject({
        grossPay: "100000.00",
        paye: "0.00",
        nssfEmployee: "0.00",
        nssfEmployer: "0.00",
        shif: "0.00",
        housingLevy: "0.00",
        netPay: "100000.00",
      });
      expect(line?.missingRateTypes.sort()).toEqual(run.missingRateTypes.sort());

      const overview = await getPayrollOverview(ctx.db, fixture.facility.id);
      expect(overview.missingRateTypes.sort()).toEqual(run.missingRateTypes.sort());
    });
  });

  it("registers every HR and payroll table for sync with the right protection", async () => {
    await withFixture({ rates: false }, async (fixture) => {
      const rows = (await ctx.db.execute(sql`
        SELECT table_name, capture, no_hard_delete, append_only
        FROM sync_tables
        WHERE table_name IN (
          'employees', 'positions', 'employment_contracts', 'shift_templates',
          'shift_assignments', 'attendance_records', 'leave_requests',
          'payroll_runs', 'payroll_lines', 'payslips', 'payroll_run_approvals'
        )
        ORDER BY table_name
      `)) as { rows: Array<Record<string, unknown>> };
      expect(rows.rows).toHaveLength(11);
      for (const row of rows.rows) {
        expect(row.capture).toBe(true);
        expect(row.no_hard_delete).toBe(true);
        const appendOnly = ["payslips", "payroll_lines", "payroll_run_approvals"].includes(
          String(row.table_name),
        );
        expect(row.append_only).toBe(appendOnly);
      }
      expect(fixture.admin.userId).toBeTruthy();
    });
  });
});
