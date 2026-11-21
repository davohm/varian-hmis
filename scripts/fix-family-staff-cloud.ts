/**
 * Corrects the FAM role accounts so they are cloud-owned (the supported
 * topology): removes branch-only copies, recreates the same accounts through
 * createStaff on the cloud hub with the already generated passwords, and lets
 * the ordinary pull channel repopulate the branch.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}
import { inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { createStaff } from "../src/server/commands/admin";
import { createDatabase } from "../src/server/db/client";
import { user } from "../src/server/db/schema";

const FACILITY_ID = "01a1fda9-b1d1-717a-9fe0-c3b523d937ec";
const BRANCH_ID = "01a1fda9-bce4-7e3b-b74e-7249aa2e64cb";
const ADMIN_ID = "01a1fda9-c93c-72c5-95d7-321f74c07f25";
const CREDENTIAL_FILE = ".env.staff-fam.local";

type StaffRole = "receptionist" | "triage_nurse" | "doctor" | "lab_tech" | "pharmacist" | "cashier" | "accountant" | "finance_officer" | "revenue_cycle_officer" | "auditor" | "regulatory_officer" | "dpo";
const nameByRole: Record<StaffRole, string> = {
  receptionist: "Reception Officer",
  triage_nurse: "Triage Nurse",
  doctor: "Medical Officer",
  lab_tech: "Laboratory Technologist",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  accountant: "Accountant",
  finance_officer: "Finance Officer",
  revenue_cycle_officer: "Revenue Cycle Officer",
  auditor: "Auditor",
  regulatory_officer: "Regulatory Officer",
  dpo: "Data Protection Officer",
};

const branchUrl = readEnvFile(".env.branch-fam").DIRECT_DATABASE_URL;
const cloudUrl = readEnvFile(".env.local").DIRECT_DATABASE_URL;
if (!branchUrl || !cloudUrl) throw new Error("Branch and cloud DIRECT_DATABASE_URL values are required");

const creds = readFileSync(CREDENTIAL_FILE, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.includes("=") && line.includes("|"))
  .map((line) => {
    const [left, right] = line.split("=", 2);
    const [email, staffNumber, password] = right.split("|");
    return { local: left, email, staffNumber, password };
  });

const branch = createDatabase(branchUrl, "clinic");
const cloud = createDatabase(cloudUrl, "cloud");

async function main() {
  const emails = creds.map((cred) => cred.email);
  const actor = { userId: ADMIN_ID, ip: "127.0.0.1", deviceId: "fam-staff-corrector" };

  await branch.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
    await tx.delete(user).where(inArray(user.email, emails));
  });

  let created = 0;
  let existing = 0;
  for (const cred of creds) {
    const role = cred.local as StaffRole;
    const cloudUser = await cloud.db
      .select({ id: user.id })
      .from(user)
      .where(sql`${user.email} = ${cred.email}`)
      .limit(1);
    if (cloudUser[0]) {
      existing += 1;
      continue;
    }
    await createStaff(
      {
        facilityId: FACILITY_ID,
        idempotencyKey: randomUUID(),
        actor,
        name: nameByRole[role],
        email: cred.email,
        password: cred.password,
        staffNumber: cred.staffNumber,
        phone: null,
        scopes: [{ role, facilityId: FACILITY_ID, branchId: BRANCH_ID }],
      },
      { database: cloud.db, mode: "cloud", allowCrossAuthority: true },
    );
    created += 1;
  }

  console.log(JSON.stringify({ removedFromBranch: emails.length, createdInCloud: created, alreadyInCloud: existing }));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await branch.pool.end();
    await cloud.pool.end();
  });
