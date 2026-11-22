import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { HR_READ_ROLES, HR_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  assignShift,
  createEmployee,
  createEmploymentContract,
  createPosition,
  createShiftTemplate,
  decideLeave,
  recordAttendance,
  requestLeave,
} from "@/server/commands/hr";
import { db } from "@/server/db/client";
import {
  getHrOverview,
  listAttendance,
  listContracts,
  listEmployees,
  listLeaveRequests,
  listPayrollEmployees,
  listPositions,
  listShiftTemplates,
} from "@/server/queries/hr";

import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  createPosition: (input) => createPosition(input as Parameters<typeof createPosition>[0]),
  createEmployee: (input) => createEmployee(input as Parameters<typeof createEmployee>[0]),
  createEmploymentContract: (input) =>
    createEmploymentContract(input as Parameters<typeof createEmploymentContract>[0]),
  createShiftTemplate: (input) =>
    createShiftTemplate(input as Parameters<typeof createShiftTemplate>[0]),
  assignShift: (input) => assignShift(input as Parameters<typeof assignShift>[0]),
  recordAttendance: (input) => recordAttendance(input as Parameters<typeof recordAttendance>[0]),
  requestLeave: (input) => requestLeave(input as Parameters<typeof requestLeave>[0]),
  decideLeave: (input) => decideLeave(input as Parameters<typeof decideLeave>[0]),
};

export async function GET() {
  try {
    const { facilityId } = await requireApiFacility(HR_READ_ROLES);
    const today = new Date().toISOString().slice(0, 10);
    const [overview, employees, positions, contracts, shiftTemplates, attendance, leave, payrollEmployees] =
      await Promise.all([
        getHrOverview(db, facilityId, today),
        listEmployees(db, facilityId),
        listPositions(db, facilityId),
        listContracts(db, facilityId),
        listShiftTemplates(db, facilityId),
        listAttendance(db, facilityId),
        listLeaveRequests(db, facilityId),
        listPayrollEmployees(db, facilityId),
      ]);

    return NextResponse.json({
      overview,
      employees,
      positions,
      contracts,
      shiftTemplates,
      attendance,
      leave,
      payrollEmployees,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(request, HR_WRITE_ROLES, commands, "Invalid HR command");
}
