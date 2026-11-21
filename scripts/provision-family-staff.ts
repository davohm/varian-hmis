/**
 * One-off provisioning of FAM role accounts through the supported command path.
 *
 * Generated passwords are written only to .env.staff-fam.local (gitignored).
 * They are never printed. Accounts are deactivated, never deleted, when staff
 * change; reissue with named individual addresses once the roster is known.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createStaff } from "../src/server/commands/admin";
import { createDatabase } from "../src/server/db/client";
import { user } from "../src/server/db/schema";
import { eq } from "drizzle-orm";

const FACILITY_ID = "01a1fda9-b1d1-717a-9fe0-c3b523d937ec";
const BRANCH_ID = "01a1fda9-bce4-7e3b-b74e-7249aa2e64cb";
const ADMIN_ID = "01a1fda9-c93c-72c5-95d7-321f74c07f25";
const CREDENTIAL_FILE = ".env.staff-fam.local";

const roles = [
  { role: "receptionist", name: "Reception Officer", local: "reception", number: "FAM-RECEP-01" },
  { role: "triage_nurse", name: "Triage Nurse", local: "triage", number: "FAM-TRIAGE-01" },
  { role: "doctor", name: "Medical Officer", local: "doctor", number: "FAM-DOCTOR-01" },
  { role: "lab_tech", name: "Laboratory Technologist", local: "lab", number: "FAM-LAB-01" },
  { role: "pharmacist", name: "Pharmacist", local: "pharmacy", number: "FAM-PHARM-01" },
  { role: "cashier", name: "Cashier", local: "cashier", number: "FAM-CASH-01" },
  { role: "accountant", name: "Accountant", local: "accountant", number: "FAM-ACCT-01" },
  { role: "finance_officer", name: "Finance Officer", local: "finance", number: "FAM-FIN-01" },
  { role: "revenue_cycle_officer", name: "Revenue Cycle Officer", local: "revenue", number: "FAM-REV-01" },
  { role: "auditor", name: "Auditor", local: "auditor", number: "FAM-AUDIT-01" },
  { role: "regulatory_officer", name: "Regulatory Officer", local: "regulatory", number: "FAM-REG-01" },
  { role: "dpo", name: "Data Protection Officer", local: "dpo", number: "FAM-DPO-01" },
] as const;

const url = process.env.DIRECT_DATABASE_URL;
if (!url) throw new Error("DIRECT_DATABASE_URL must be set to the branch database");

const { db, pool } = createDatabase(url, "clinic");
const options = { database: db, mode: "clinic" as const };
const actor = { userId: ADMIN_ID, ip: "127.0.0.1", deviceId: "fam-staff-provisioner" };

async function main() {
  const lines = [
    "# Generated FAM role-account credentials. Keep local; never commit or share.",
    "# Rotate any account whose password leaves this machine.",
    "",
  ];
  const created: string[] = [];
  const existing: string[] = [];

  for (const item of roles) {
    const email = `familyhospitalthindigua+${item.local}@gmail.com`.toLowerCase();
    const found = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (found[0]) {
      existing.push(item.role);
      continue;
    }

    const password = randomBytes(18).toString("base64url");
    await createStaff(
      {
        facilityId: FACILITY_ID,
        idempotencyKey: randomUUID(),
        actor,
        name: item.name,
        email,
        password,
        staffNumber: item.number,
        phone: null,
        scopes: [{ role: item.role, facilityId: FACILITY_ID, branchId: BRANCH_ID }],
      },
      options,
    );
    lines.push(`${item.role}=${email}|${item.number}|${password}`);
    created.push(item.role);
  }

  if (created.length > 0) {
    writeFileSync(CREDENTIAL_FILE, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(JSON.stringify({ created: created.length, existing: existing.length, roles: created, credentialFile: CREDENTIAL_FILE }));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
