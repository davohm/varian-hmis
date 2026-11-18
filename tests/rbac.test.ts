import { describe, expect, it } from "vitest";

import {
  ForbiddenError,
  UnauthorizedError,
  authorizeStaffAccess,
  primaryRoleFor,
  type StaffScope,
} from "../src/server/auth/rbac";
import type { Role } from "../src/server/db/schema/staff";

function scope(role: Role, facilityId = "facility-a", branchId: string | null = null): StaffScope {
  return {
    role,
    facilityId,
    facilityCode: "FAM",
    facilityName: "Family Afya Modern Medical Centre",
    branchId,
    branchCode: branchId ? "MAIN" : null,
    branchName: branchId ? "Main Branch" : null,
  };
}

describe("staff access rules", () => {
  it("allows each role to open only its own screen", () => {
    const roles: Role[] = [
      "receptionist",
      "triage_nurse",
      "doctor",
      "lab_tech",
      "pharmacist",
      "cashier",
      "admin",
    ];

    for (const role of roles) {
      const scopes = [scope(role)];
      for (const requested of roles) {
        expect(authorizeStaffAccess(scopes, [requested], "facility-a")).toBe(role === requested || role === "admin");
      }
    }
  });

  it("lets an administrator override any role guard but not a non-admin into admin", () => {
    expect(authorizeStaffAccess([scope("admin")], ["receptionist"], "facility-a")).toBe(true);
    expect(authorizeStaffAccess([scope("receptionist")], ["admin"], "facility-a")).toBe(false);
  });

  it("requires the active facility to match a staff scope", () => {
    expect(authorizeStaffAccess([scope("receptionist")], ["receptionist"], "facility-a")).toBe(true);
    expect(authorizeStaffAccess([scope("receptionist")], ["receptionist"], "facility-b")).toBe(false);
    expect(authorizeStaffAccess([scope("receptionist")], ["receptionist"], null)).toBe(false);
  });

  it("honours a null branch as all branches and a set branch as one branch only", () => {
    const allBranches = [scope("pharmacist", "facility-a", null)];
    expect(authorizeStaffAccess(allBranches, ["pharmacist"], "facility-a", "branch-1")).toBe(true);
    expect(authorizeStaffAccess(allBranches, ["pharmacist"], "facility-a", "branch-2")).toBe(true);

    const oneBranch = [scope("pharmacist", "facility-a", "branch-1")];
    expect(authorizeStaffAccess(oneBranch, ["pharmacist"], "facility-a", "branch-1")).toBe(true);
    expect(authorizeStaffAccess(oneBranch, ["pharmacist"], "facility-a", "branch-2")).toBe(false);
  });

  it("denies inactive or unassigned staff because they have no active scopes", () => {
    expect(authorizeStaffAccess([], ["doctor"], "facility-a")).toBe(false);
    expect(authorizeStaffAccess([], [], "facility-a")).toBe(false);
  });

  it("allows any active role when the requested role list is empty", () => {
    expect(authorizeStaffAccess([scope("cashier")], [], "facility-a")).toBe(true);
    expect(authorizeStaffAccess([], [], "facility-a")).toBe(false);
  });

  it("selects the matching role for a multi-role user", () => {
    const scopes = [scope("cashier"), scope("pharmacist")];
    expect(primaryRoleFor(scopes, ["pharmacist"])).toBe("pharmacist");
    expect(primaryRoleFor(scopes, [])).toBe("cashier");
    expect(primaryRoleFor([], ["doctor"])).toBeNull();
  });

  it("exposes distinct guard errors for forbidden and unauthenticated access", () => {
    expect(new ForbiddenError()).toBeInstanceOf(Error);
    expect(new ForbiddenError().name).toBe("ForbiddenError");
    expect(new ForbiddenError().message).toContain("do not have permission");
    expect(new UnauthorizedError().name).toBe("UnauthorizedError");
  });
});
