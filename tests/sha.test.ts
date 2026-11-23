import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toCents } from "../src/lib/billing";
import { DEFAULT_CHART_OF_ACCOUNTS } from "../src/lib/finance";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { createLedgerAccount, postManualJournal } from "../src/server/commands/finance";
import { createPayer } from "../src/server/commands/revenue";
import {
  approveExemption,
  approveWaiver,
  createBenefitPackage,
  createEmpanelment,
  createShaClaim,
  decideShaPreAuthorization,
  recordShaAdjudication,
  recordShaDenial,
  recordShaRemittance,
  reconcileShaPaymentReport,
  requestShaPreAuthorization,
  requestShaWaiver,
  reworkShaClaim,
  submitShaClaim,
  updateEmpanelmentStatus,
  verifyShaEligibility,
} from "../src/server/commands/sha";
import {
  auditLog,
  claimLines,
  claims,
  dataConsents,
  encounters,
  facilityLicences,
  facilityRegulatoryProfiles,
  invoices,
  patients,
  remittances,
  shaAdjudicationCodes,
  shaEligibilityChecks,
  shaPaymentReconciliation,
  shaReconciliationLines,
  syncOutbox,
} from "../src/server/db/schema";
import { getTrialBalance } from "../src/server/queries/finance";
import { getShaClaim } from "../src/server/queries/sha";

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

const SETUP = { userId: "vitest-sha-setup", deviceId: "sha-station" };
const PREPARER = { userId: "vitest-sha-preparer", deviceId: "sha-station" };
const SUBMITTER = { userId: "vitest-sha-submitter", deviceId: "sha-station" };
const APPROVER = { userId: "vitest-sha-approver", deviceId: "sha-station" };
const FINANCE = { userId: "vitest-sha-finance", deviceId: "sha-station" };
const CASHIER = { userId: "vitest-sha-cashier", deviceId: "sha-station" };
const REQUESTER = { userId: "vitest-sha-waiver-requester", deviceId: "sha-station" };

interface ShaFixture {
  facility: { id: string; code: string };
  branchId: string;
  accounts: Record<string, string>;
  payerId: string;
  patientId: string;
  encounterId: string;
  invoiceId: string;
  kmpdcNumber: string;
  packageCode: string;
}

async function withShaFacility<T>(run: (fixture: ShaFixture) => Promise<T>): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const accounts: Record<string, string> = {};
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const kmpdcNumber = `KMPDC-${suffix}`;
  const packageCode = `SHIF-${suffix}`;

  await ctx.db.insert(facilityRegulatoryProfiles).values({
    facilityId: facility.id,
    kmpdcNumber,
    kmhflId: `KMHFL-${suffix}`,
    licenceStatus: "active",
    createdBy: "vitest",
  });
  await ctx.db.insert(facilityLicences).values({
    facilityId: facility.id,
    licenceType: "kmpdc_facility",
    licenceNo: `LIC-${suffix}`,
    issueDate: "2020-01-01",
    expiryDate: "2099-12-31",
    status: "active",
    createdBy: "vitest",
  });

  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    const created = await createLedgerAccount(
      {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: SETUP,
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

  await ctx.db.insert(shaAdjudicationCodes).values([
    {
      facilityId: facility.id,
      code: "APP",
      description: "Approved as billed",
      category: "approved",
      retryable: false,
      createdBy: "vitest",
    },
    {
      facilityId: facility.id,
      code: "RED",
      description: "Approved at a reduced amount",
      category: "reduced",
      retryable: true,
      createdBy: "vitest",
    },
    {
      facilityId: facility.id,
      code: "REJ",
      description: "Rejected",
      category: "rejected",
      retryable: true,
      actionHint: "Correct the claim and resubmit",
      createdBy: "vitest",
    },
    {
      facilityId: facility.id,
      code: "INF",
      description: "Additional information requested",
      category: "info",
      retryable: true,
      createdBy: "vitest",
    },
  ]);

  const payer = await createPayer(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: SETUP,
      code: `SHA-${suffix}`,
      name: "Social Health Authority",
      kind: "insurer",
    },
    { database: ctx.db },
  );

  const patientId = newId();
  await ctx.db.insert(patients).values({
    id: patientId,
    facilityId: facility.id,
    mrn: `MRN-${suffix}`,
    firstName: "Amina",
    lastName: "Otieno",
    sex: "female",
    payerType: "insurance",
    payerMemberNo: `MEMBER-${suffix}`,
    createdBy: "vitest",
  });

  const encounterId = newId();
  await ctx.db.insert(encounters).values({
    id: encounterId,
    facilityId: facility.id,
    branchId,
    patientId,
    encounterNo: `ENC-${suffix}`,
    payerType: "insurance",
    createdBy: "vitest",
  });

  const invoiceId = newId();
  await ctx.db.insert(invoices).values({
    id: invoiceId,
    facilityId: facility.id,
    encounterId,
    invoiceNo: `INV-${suffix}`,
    subtotal: "10000.00",
    total: "10000.00",
    paid: "0.00",
    status: "open",
    isShaClaimable: true,
    createdBy: "vitest",
  });

  await ctx.db.insert(dataConsents).values({
    facilityId: facility.id,
    patientId,
    consentType: "payer_sharing",
    consentVersion: "v1",
    granted: true,
    grantedAt: new Date(),
    grantedBy: "vitest",
    source: "test",
    validFrom: new Date("2020-01-01T00:00:00.000Z"),
    validTo: null,
    createdBy: "vitest",
  });

  try {
    return await run({
      facility,
      branchId,
      accounts,
      payerId: payer.payerId,
      patientId,
      encounterId,
      invoiceId,
      kmpdcNumber,
      packageCode,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

interface ShaSetup {
  empanelmentId: string;
  benefitPackageId: string;
}

async function setupEmpanelmentAndPackage(
  fixture: ShaFixture,
  options: { expiry?: string; status?: "active" | "suspended" | "expired" | "terminated" } = {},
): Promise<ShaSetup> {
  const empanelment = await createEmpanelment(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: SETUP,
      kmpdcNumber: fixture.kmpdcNumber,
      fund: "shif",
      schemeCode: `SHIF-BASE-${randomUUID().slice(0, 8)}`,
      schemeName: "SHIF base scheme",
      contractNo: "SHA-CONTRACT-001",
      effectiveFrom: "2020-01-01",
      expiryDate: options.expiry ?? "2099-12-31",
      tariffVersion: "TARIFF-2026",
      qualityCertProgram: "Quality improvement programme",
    },
    { database: ctx.db },
  );

  if (options.status && options.status !== "active") {
    await updateEmpanelmentStatus(
      {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: SETUP,
        empanelmentId: empanelment.empanelmentId,
        status: options.status,
        reason: "Test fixture status",
      },
      { database: ctx.db },
    );
  }

  const benefitPackage = await createBenefitPackage(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: SETUP,
      fund: "shif",
      packageCode: `${fixture.packageCode}-${randomUUID().slice(0, 6)}`,
      name: "SHIF outpatient benefit package",
      careType: "outpatient",
      effectiveFrom: "2020-01-01",
      effectiveTo: "2099-12-31",
      items: [
        {
          shaServiceCode: "CONS",
          description: "Consultation",
          coverage: "full",
          unitPrice: "1000.00",
          coPayPercent: 0,
        },
        {
          shaServiceCode: "PART",
          description: "Part-covered procedure",
          coverage: "partial",
          unitPrice: "1000.00",
          coPayPercent: 20,
        },
        {
          shaServiceCode: "EXCL",
          description: "Excluded cosmetic service",
          coverage: "excluded",
          unitPrice: "500.00",
          coPayPercent: 0,
        },
        {
          shaServiceCode: "THRESH",
          description: "High-cost imaging",
          coverage: "full",
          unitPrice: "4000.00",
          preauthThreshold: "3000.00",
        },
        {
          shaServiceCode: "HIGH",
          description: "Inpatient admission",
          coverage: "full",
          unitPrice: "5000.00",
          requiresPreauth: true,
        },
      ],
    },
    { database: ctx.db },
  );

  return {
    empanelmentId: empanelment.empanelmentId,
    benefitPackageId: benefitPackage.benefitPackageId,
  };
}

type ClaimInput = Parameters<typeof createShaClaim>[0];

function claimInput(fixture: ShaFixture, setup: ShaSetup, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    facilityId: fixture.facility.id,
    idempotencyKey: newIdempotencyKey(),
    actor: PREPARER,
    payerId: fixture.payerId,
    patientId: fixture.patientId,
    encounterId: fixture.encounterId,
    invoiceId: fixture.invoiceId,
    empanelmentId: setup.empanelmentId,
    benefitPackageId: setup.benefitPackageId,
    fund: "shif",
    lines: [{ shaServiceCode: "CONS", description: "Consultation", amount: "1000.00" }],
    ...overrides,
  };
}

async function createSubmittedClaim(fixture: ShaFixture, setup: ShaSetup, overrides: Partial<ClaimInput> = {}) {
  const claim = await createShaClaim(claimInput(fixture, setup, overrides), { database: ctx.db });
  await submitShaClaim(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: SUBMITTER,
      claimId: claim.claimId,
    },
    { database: ctx.db },
  );
  return claim;
}

async function approveClaim(fixture: ShaFixture, claimId: string, amount: string) {
  return recordShaAdjudication(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: APPROVER,
      claimId,
      code: "APP",
      approvedAmount: amount,
    },
    { database: ctx.db },
  );
}

async function auditCount(facilityId: string, action: string) {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.facilityId, facilityId), eq(auditLog.action, action)));
  return rows.length;
}

async function outboxCount(facilityId: string, tableName: string, recordId?: string) {
  const rows = await ctx.db
    .select()
    .from(syncOutbox)
    .where(
      recordId
        ? and(
            eq(syncOutbox.facilityId, facilityId),
            eq(syncOutbox.tableName, tableName),
            eq(syncOutbox.recordId, recordId),
          )
        : and(eq(syncOutbox.facilityId, facilityId), eq(syncOutbox.tableName, tableName)),
    );
  return rows.length;
}

describe("Phase 22 — SHA / SHIF revenue cycle", () => {
  it("rules 1 and 2: requires an active, unexpired empanelment for the fund", async () => {
    await withShaFacility(async (fixture) => {
      await expect(
        createShaClaim(
          claimInput(fixture, {
            empanelmentId: newId(),
            benefitPackageId: newId(),
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("SHA empanelment not found for this fund");

      const expired = await setupEmpanelmentAndPackage(fixture, { expiry: "2020-06-01" });
      await expect(
        createShaClaim(claimInput(fixture, expired), { database: ctx.db }),
      ).rejects.toThrow("The SHA empanelment is expired; new claims are blocked");

      const terminated = await setupEmpanelmentAndPackage(fixture, { status: "terminated" });
      await expect(
        createShaClaim(claimInput(fixture, terminated), { database: ctx.db }),
      ).rejects.toThrow("The SHA empanelment is terminated; new claims are blocked");
    });
  });

  it("rule 3: excluded and unlisted lines are never silently billed to SHA", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);

      await expect(
        createShaClaim(
          claimInput(fixture, setup, {
            lines: [{ shaServiceCode: "EXCL", description: "Cosmetic service", amount: "500.00" }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("is an excluded benefit; bill it to the patient explicitly");

      await expect(
        createShaClaim(
          claimInput(fixture, setup, {
            lines: [{ shaServiceCode: "UNLISTED", description: "Unknown service", amount: "500.00" }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("is not covered by the benefit package");

      const patientPay = await createShaClaim(
        claimInput(fixture, setup, {
          lines: [
            {
              shaServiceCode: "EXCL",
              description: "Cosmetic service",
              amount: "500.00",
              patientPay: true,
            },
          ],
        }),
        { database: ctx.db },
      );
      expect(patientPay.billedAmount).toBe("0.00");
      expect(patientPay.patientCoPay).toBe("500.00");
      expect(patientPay.coverage[0]?.coverage).toBe("excluded");
    });
  });

  it("rule 4: a line above the preauth threshold needs an approved authorisation", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const highCostLines = [{ shaServiceCode: "THRESH", description: "High-cost imaging", amount: "4000.00" }];

      await expect(
        createShaClaim(claimInput(fixture, setup, { lines: highCostLines }), { database: ctx.db }),
      ).rejects.toThrow("needs a pre-authorisation");

      const request = await requestShaPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          empanelmentId: setup.empanelmentId,
          benefitPackageId: setup.benefitPackageId,
          fund: "shif",
          requestedAmount: "4000.00",
          expiresAt: "2099-12-31",
        },
        { database: ctx.db },
      );
      await decideShaPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: APPROVER,
          preAuthId: request.preAuthId,
          decision: "approved",
          approvedAmount: "4000.00",
          shaAuthRef: "SHA-AUTH-4000",
        },
        { database: ctx.db },
      );

      const claim = await createShaClaim(
        claimInput(fixture, setup, { lines: highCostLines, preAuthId: request.preAuthId }),
        { database: ctx.db },
      );
      expect(claim.total).toBe("4000.00");
    });
  });

  it("rule 5: the claim total equals the sum of its lines to the cent", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createShaClaim(
        claimInput(fixture, setup, {
          lines: [
            { shaServiceCode: "CONS", description: "Consultation", amount: "1000.00" },
            { shaServiceCode: "PART", description: "Part-covered procedure", amount: "1000.00" },
          ],
        }),
        { database: ctx.db },
      );

      const lines = await ctx.db
        .select()
        .from(claimLines)
        .where(and(eq(claimLines.facilityId, fixture.facility.id), eq(claimLines.claimId, claim.claimId)));
      const lineCents = lines.reduce((sum, line) => sum + toCents(line.amount), 0);
      expect(lineCents).toBe(toCents(claim.total));
      expect(claim.total).toBe("2000.00");
      expect(claim.billedAmount).toBe("1800.00");
      expect(claim.patientCoPay).toBe("200.00");
      expect(toCents(claim.billedAmount) + toCents(claim.patientCoPay)).toBe(toCents(claim.total));
    });
  });

  it("rule 6: an expired pre-authorisation blocks a claim that relies on it", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const request = await requestShaPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          empanelmentId: setup.empanelmentId,
          fund: "shif",
          requestedAmount: "5000.00",
        },
        { database: ctx.db },
      );
      await decideShaPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: APPROVER,
          preAuthId: request.preAuthId,
          decision: "approved",
          approvedAmount: "5000.00",
          expiresAt: "2020-01-01",
        },
        { database: ctx.db },
      );

      await expect(
        createShaClaim(
          claimInput(fixture, setup, {
            preAuthId: request.preAuthId,
            lines: [{ shaServiceCode: "HIGH", description: "Inpatient admission", amount: "5000.00" }],
          }),
          { database: ctx.db },
        ),
      ).rejects.toThrow("The pre-authorisation has expired");
    });
  });

  it("rule 7: the preparer cannot submit their own claim", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createShaClaim(claimInput(fixture, setup), { database: ctx.db });

      await expect(
        submitShaClaim(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: PREPARER,
            claimId: claim.claimId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("The claim preparer cannot submit this claim");

      const submitted = await submitShaClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: SUBMITTER,
          claimId: claim.claimId,
        },
        { database: ctx.db },
      );
      expect(submitted.status).toBe("submitted");
      expect(submitted.shaClaimRef).toBe(`SHA-${claim.claimNo}`);
    });
  });

  it("rule 8: sha_claim_ref is allocated once and copied unchanged on rework", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createSubmittedClaim(fixture, setup);

      await recordShaDenial(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: SUBMITTER,
          claimId: claim.claimId,
          code: "REJ",
          reason: "Missing practitioner signature",
        },
        { database: ctx.db },
      );

      const rework = await reworkShaClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          claimId: claim.claimId,
          note: "Signature attached",
        },
        { database: ctx.db },
      );

      expect(rework.status).toBe("draft");
      expect(rework.supersedesClaimId).toBe(claim.claimId);
      expect(rework.shaClaimRef).toBe(`SHA-${claim.claimNo}`);
      const original = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);
      expect(original?.status).toBe("rejected");
      expect(original?.denials[0]?.reason).toBe("Missing practitioner signature");
    });
  });

  it("rule 9: excess remittance is refused and audited until a waiver is approved", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createSubmittedClaim(fixture, setup);
      await approveClaim(fixture, claim.claimId, "1000.00");
      const detail = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);
      const lineId = detail!.lines[0]!.id;

      await expect(
        recordShaRemittance(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: FINANCE,
            claimId: claim.claimId,
            allocations: [{ claimLineId: lineId, amount: "1500.00" }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("an approved waiver is required");
      expect(await auditCount(fixture.facility.id, "sha_remittance.excess_refused")).toBe(1);

      const waiver = await requestShaWaiver(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: REQUESTER,
          kind: "waiver",
          claimId: claim.claimId,
          amount: "500.00",
          reason: "Approved goodwill adjustment",
        },
        { database: ctx.db },
      );
      await approveWaiver(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: APPROVER,
          waiverId: waiver.waiverId,
          decision: "approved",
        },
        { database: ctx.db },
      );

      const paid = await recordShaRemittance(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: FINANCE,
          claimId: claim.claimId,
          waiverId: waiver.waiverId,
          allocations: [{ claimLineId: lineId, amount: "1500.00" }],
        },
        { database: ctx.db },
      );
      expect(paid.paidAmount).toBe("1500.00");
      expect(paid.status).toBe("paid");
      expect(await auditCount(fixture.facility.id, "sha_waiver.approved")).toBe(1);
    });
  });

  it("rule 10: remittance allocations target claim lines and sum to the receipt", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createSubmittedClaim(fixture, setup, {
        lines: [
          { shaServiceCode: "CONS", description: "Consultation", amount: "1000.00" },
          { shaServiceCode: "PART", description: "Part-covered procedure", amount: "1000.00" },
        ],
      });
      await approveClaim(fixture, claim.claimId, "2000.00");
      const detail = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);
      const [first, second] = detail!.lines;

      const result = await recordShaRemittance(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: FINANCE,
          claimId: claim.claimId,
          allocations: [
            { claimLineId: first!.id, amount: "1200.00" },
            { claimLineId: second!.id, amount: "800.00" },
          ],
        },
        { database: ctx.db },
      );

      expect(result.amount).toBe("2000.00");
      expect(result.remittanceIds).toHaveLength(2);
      const rows = await ctx.db
        .select()
        .from(remittances)
        .where(and(eq(remittances.facilityId, fixture.facility.id), eq(remittances.claimId, claim.claimId)));
      expect(rows.map((row) => row.claimLineId).sort()).toEqual([first!.id, second!.id].sort());
      expect(rows.reduce((sum, row) => sum + toCents(row.amount), 0)).toBe(toCents(result.amount));
    });
  });

  it("rule 11: denials require a configured rejection code and reason, and rework links a new draft", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createSubmittedClaim(fixture, setup);

      await expect(
        recordShaDenial(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: SUBMITTER,
            claimId: claim.claimId,
            code: "REJ",
            reason: "   ",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow();

      await expect(
        recordShaDenial(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: SUBMITTER,
            claimId: claim.claimId,
            code: "NO-SUCH-CODE",
            reason: "Bad code",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("SHA adjudication code NO-SUCH-CODE is not configured for this facility");

      await expect(
        recordShaDenial(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: SUBMITTER,
            claimId: claim.claimId,
            code: "APP",
            reason: "Not a rejection",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("Adjudication code APP is not a rejection code");

      const denial = await recordShaDenial(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: SUBMITTER,
          claimId: claim.claimId,
          code: "REJ",
          reason: "Incorrect tariff code",
        },
        { database: ctx.db },
      );
      expect(denial.status).toBe("open");
      expect(denial.reason).toBe("Incorrect tariff code");

      const claimsBefore = await ctx.db
        .select()
        .from(claims)
        .where(eq(claims.facilityId, fixture.facility.id));
      const rework = await reworkShaClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          claimId: claim.claimId,
          denialId: denial.denialId,
        },
        { database: ctx.db },
      );
      const claimsAfter = await ctx.db
        .select()
        .from(claims)
        .where(eq(claims.facilityId, fixture.facility.id));
      expect(claimsAfter).toHaveLength(claimsBefore.length + 1);
      expect(claimsAfter.find((row) => row.id === rework.claimId)?.supersedesClaimId).toBe(claim.claimId);
      expect(rework.denialReason).toContain("Incorrect tariff code");
    });
  });

  it("rule 12: reconciliation matches by KMPDC and period; unmatched cash stays as variance", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createSubmittedClaim(fixture, setup);
      const detail = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);

      const reconciliation = await reconcileShaPaymentReport(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: FINANCE,
          kmpdcNumber: fixture.kmpdcNumber,
          reportPeriod: "2020-01",
          reportRef: "SHA-PAY-OLD",
          shaReportedAmount: "250.00",
          lines: [{ claimRef: detail!.shaClaimRef!, shaAmount: "250.00" }],
        },
        { database: ctx.db },
      );

      expect(reconciliation.lines[0]?.status).toBe("unmatched");
      expect(reconciliation.lines[0]?.claimId).toBeNull();
      expect(reconciliation.unmatchedAmount).toBe("250.00");
      expect(reconciliation.variance).toBe("250.00");
      expect(reconciliation.status).toBe("variance");
      const storedLine = await ctx.db
        .select()
        .from(shaReconciliationLines)
        .where(
          and(
            eq(shaReconciliationLines.facilityId, fixture.facility.id),
            eq(shaReconciliationLines.reconciliationId, reconciliation.reconciliationId),
          ),
        );
      expect(storedLine[0]?.reason).toBe("SHA payment could not be matched to a claim for this KMPDC/period");

      await expect(
        reconcileShaPaymentReport(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: FINANCE,
            kmpdcNumber: fixture.kmpdcNumber,
            reportPeriod: "2020-01",
            shaReportedAmount: "250.00",
            lines: [{ claimRef: detail!.shaClaimRef!, shaAmount: "250.00" }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("is already reconciled");

      const stored = await ctx.db
        .select()
        .from(shaPaymentReconciliation)
        .where(eq(shaPaymentReconciliation.facilityId, fixture.facility.id));
      expect(stored).toHaveLength(1);
      expect(toCents(stored[0]!.variance)).toBe(25000);
    });
  });

  it("rule 14: every claim joins back to its encounter and invoice", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createShaClaim(claimInput(fixture, setup), { database: ctx.db });
      const detail = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);

      expect(detail?.encounter.id).toBe(fixture.encounterId);
      expect(detail?.invoice?.id).toBe(fixture.invoiceId);
      expect(detail?.patientId).toBe(fixture.patientId);

      const source = await ctx.db
        .select({ encounterNo: encounters.encounterNo, invoiceNo: invoices.invoiceNo })
        .from(encounters)
        .innerJoin(invoices, eq(invoices.encounterId, encounters.id))
        .where(eq(encounters.id, fixture.encounterId));
      expect(source[0]?.encounterNo).toBe(detail?.encounter.encounterNo);
      expect(source[0]?.invoiceNo).toBe(detail?.invoice?.invoiceNo);
    });
  });

  it("rule 15: audit rows, outbox rows and idempotent replay for every SHA command", async () => {
    await withShaFacility(async (fixture) => {
      const facilityId = fixture.facility.id;
      const empanelmentKey = newIdempotencyKey();
      const empanelmentInput = {
        facilityId,
        idempotencyKey: empanelmentKey,
        actor: SETUP,
        kmpdcNumber: fixture.kmpdcNumber,
        fund: "shif" as const,
        schemeCode: "SHIF-BASE",
        effectiveFrom: "2020-01-01",
        expiryDate: "2099-12-31",
      };
      const empanelment = await createEmpanelment(empanelmentInput, { database: ctx.db });
      const empanelmentOutboxRows = await outboxCount(
        facilityId,
        "sha_empanelments",
        empanelment.empanelmentId,
      );
      expect(empanelmentOutboxRows).toBe(1);
      const replayedEmpanelment = await createEmpanelment(empanelmentInput, { database: ctx.db });
      expect(replayedEmpanelment).toEqual(empanelment);
      expect(await outboxCount(facilityId, "sha_empanelments", empanelment.empanelmentId)).toBe(
        empanelmentOutboxRows,
      );

      await updateEmpanelmentStatus(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: SETUP,
          empanelmentId: empanelment.empanelmentId,
          status: "suspended",
          reason: "Temporary suspension",
        },
        { database: ctx.db },
      );
      await updateEmpanelmentStatus(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: SETUP,
          empanelmentId: empanelment.empanelmentId,
          status: "active",
        },
        { database: ctx.db },
      );

      const benefitPackage = await createBenefitPackage(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: SETUP,
          fund: "shif",
          packageCode: fixture.packageCode,
          name: "SHIF package",
          careType: "outpatient",
          effectiveFrom: "2020-01-01",
          items: [
            {
              shaServiceCode: "CONS",
              description: "Consultation",
              coverage: "full",
              unitPrice: "1000.00",
            },
          ],
        },
        { database: ctx.db },
      );

      const eligibilityKey = newIdempotencyKey();
      const eligibilityInput = {
        facilityId,
        idempotencyKey: eligibilityKey,
        actor: CASHIER,
        patientId: fixture.patientId,
        payerId: fixture.payerId,
        empanelmentId: empanelment.empanelmentId,
        fund: "shif" as const,
        eligibility: "eligible" as const,
        memberRef: "MEMBER-1",
      };
      const eligibility = await verifyShaEligibility(eligibilityInput, { database: ctx.db });
      expect(await verifyShaEligibility(eligibilityInput, { database: ctx.db })).toEqual(eligibility);

      const preauth = await requestShaPreAuthorization(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          empanelmentId: empanelment.empanelmentId,
          fund: "shif",
          requestedAmount: "1000.00",
        },
        { database: ctx.db },
      );
      await decideShaPreAuthorization(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: APPROVER,
          preAuthId: preauth.preAuthId,
          decision: "approved",
          approvedAmount: "1000.00",
        },
        { database: ctx.db },
      );

      const setup: ShaSetup = {
        empanelmentId: empanelment.empanelmentId,
        benefitPackageId: benefitPackage.benefitPackageId,
      };
      const claimKey = newIdempotencyKey();
      const claimPayload = claimInput(fixture, setup, { idempotencyKey: claimKey });
      const claim = await createShaClaim(claimPayload, { database: ctx.db });
      const claimOutboxRows = await outboxCount(facilityId, "claims", claim.claimId);
      expect(claimOutboxRows).toBe(1);
      expect(await createShaClaim(claimPayload, { database: ctx.db })).toEqual(claim);
      expect(await outboxCount(facilityId, "claims", claim.claimId)).toBe(claimOutboxRows);

      const submitKey = newIdempotencyKey();
      const submitPayload = {
        facilityId,
        idempotencyKey: submitKey,
        actor: SUBMITTER,
        claimId: claim.claimId,
      };
      const submitted = await submitShaClaim(submitPayload, { database: ctx.db });
      expect(await submitShaClaim(submitPayload, { database: ctx.db })).toEqual(submitted);

      const detail = await getShaClaim(ctx.db, facilityId, claim.claimId);
      const lineId = detail!.lines[0]!.id;
      const adjudicated = await approveClaim(fixture, claim.claimId, "1000.00");
      expect(adjudicated.status).toBe("accepted");

      // A rejected claim cannot later be remitted, so denial/rework coverage
      // uses a separate claim from the adjudicated and paid one.
      const denialClaim = await createShaClaim(
        claimInput(fixture, setup, { idempotencyKey: newIdempotencyKey() }),
        { database: ctx.db },
      );
      await submitShaClaim(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: SUBMITTER,
          claimId: denialClaim.claimId,
        },
        { database: ctx.db },
      );
      const denial = await recordShaDenial(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: SUBMITTER,
          claimId: denialClaim.claimId,
          code: "REJ",
          reason: "Duplicate line",
        },
        { database: ctx.db },
      );
      await reworkShaClaim(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          claimId: denialClaim.claimId,
          denialId: denial.denialId,
        },
        { database: ctx.db },
      );

      const waiver = await requestShaWaiver(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: CASHIER,
          kind: "exemption",
          invoiceId: fixture.invoiceId,
          amount: "100.00",
          reason: "Hardship",
        },
        { database: ctx.db },
      );
      await approveExemption(
        {
          facilityId,
          idempotencyKey: newIdempotencyKey(),
          actor: APPROVER,
          waiverId: waiver.waiverId,
          decision: "approved",
        },
        { database: ctx.db },
      );

      const remitKey = newIdempotencyKey();
      const remitPayload = {
        facilityId,
        idempotencyKey: remitKey,
        actor: FINANCE,
        claimId: claim.claimId,
        allocations: [{ claimLineId: lineId, amount: "1000.00" }],
        shaPaymentReportRef: "SHA-PAY-1",
      };
      const remittance = await recordShaRemittance(remitPayload, { database: ctx.db });
      const remittanceOutboxRows = await outboxCount(
        facilityId,
        "remittances",
        remittance.remittanceIds[0]!,
      );
      expect(remittanceOutboxRows).toBe(1);
      expect(await recordShaRemittance(remitPayload, { database: ctx.db })).toEqual(remittance);
      expect(await outboxCount(facilityId, "remittances", remittance.remittanceIds[0]!)).toBe(
        remittanceOutboxRows,
      );

      const period = submitted.submittedAt.slice(0, 7);
      const reconcileKey = newIdempotencyKey();
      const reconcilePayload = {
        facilityId,
        idempotencyKey: reconcileKey,
        actor: FINANCE,
        kmpdcNumber: fixture.kmpdcNumber,
        reportPeriod: period,
        reportRef: "SHA-PAY-1",
        shaReportedAmount: "1000.00",
        lines: [{ claimRef: submitted.shaClaimRef, shaAmount: "1000.00" }],
      };
      const reconciliation = await reconcileShaPaymentReport(reconcilePayload, { database: ctx.db });
      expect(await reconcileShaPaymentReport(reconcilePayload, { database: ctx.db })).toEqual(reconciliation);

      const expectedAudits = [
        "sha_empanelment.create",
        "sha_empanelment.status",
        "sha_benefit_package.create",
        "sha_eligibility.verify",
        "sha_preauth.request",
        "sha_preauth.decide",
        "sha_claim.create",
        "sha_claim.submit",
        "sha_claim.adjudicate",
        "sha_claim.denied",
        "sha_claim.rework",
        "sha_waiver.request",
        "sha_waiver.approved",
        "sha_remittance.record",
        "sha_reconciliation.import",
      ];
      for (const action of expectedAudits) {
        expect(await auditCount(facilityId, action), `audit: ${action}`).toBeGreaterThan(0);
      }

      const expectedOutboxTables = [
        "sha_empanelments",
        "benefit_packages",
        "benefit_package_items",
        "sha_eligibility_checks",
        "pre_authorizations",
        "claims",
        "claim_lines",
        "claim_denials",
        "sha_waivers",
        "remittances",
        "sha_payment_reconciliation",
        "sha_reconciliation_lines",
      ];
      for (const table of expectedOutboxTables) {
        expect(await outboxCount(facilityId, table), `outbox: ${table}`).toBeGreaterThan(0);
      }

    });
  });

  it("rule 13 and end to end: eligibility → pre-auth → claim → adjudication → remittance → reconciliation with a balanced trial balance", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);

      const eligibility = await verifyShaEligibility(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: CASHIER,
          patientId: fixture.patientId,
          payerId: fixture.payerId,
          empanelmentId: setup.empanelmentId,
          fund: "shif",
          memberRef: "MEMBER-E2E",
          checkRef: "CHECK-E2E",
          eligibility: "eligible",
        },
        { database: ctx.db },
      );
      expect(eligibility.eligibility).toBe("eligible");

      const preauth = await requestShaPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: PREPARER,
          payerId: fixture.payerId,
          patientId: fixture.patientId,
          encounterId: fixture.encounterId,
          empanelmentId: setup.empanelmentId,
          benefitPackageId: setup.benefitPackageId,
          fund: "shif",
          requestedAmount: "1000.00",
          expiresAt: "2099-12-31",
        },
        { database: ctx.db },
      );
      await decideShaPreAuthorization(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: APPROVER,
          preAuthId: preauth.preAuthId,
          decision: "approved",
          approvedAmount: "1000.00",
          shaAuthRef: "SHA-AUTH-E2E",
        },
        { database: ctx.db },
      );

      // Book the original invoice so the patient receivable reclassification
      // and subsequent payer cash have a complete, balanced ledger chain.
      await postManualJournal(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: SETUP,
          entryDate: new Date().toISOString().slice(0, 10),
          description: "Test invoice posting",
          lines: [
            { accountId: fixture.accounts.patient_receivable, debit: "1000.00", credit: 0 },
            { accountId: fixture.accounts.service_revenue, debit: 0, credit: "1000.00" },
          ],
        },
        { database: ctx.db },
      );

      const claim = await createShaClaim(
        claimInput(fixture, setup, { preAuthId: preauth.preAuthId }),
        { database: ctx.db },
      );
      const submitted = await submitShaClaim(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: SUBMITTER,
          claimId: claim.claimId,
        },
        { database: ctx.db },
      );
      const adjudication = await approveClaim(fixture, claim.claimId, "1000.00");
      expect(adjudication.status).toBe("accepted");

      const detail = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);
      const lineId = detail!.lines[0]!.id;
      const remittance = await recordShaRemittance(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: FINANCE,
          claimId: claim.claimId,
          allocations: [{ claimLineId: lineId, amount: "1000.00" }],
          shaPaymentReportRef: "SHA-PAY-E2E",
          bankReference: "BANK-E2E",
          paymentDate: new Date().toISOString().slice(0, 10),
        },
        { database: ctx.db },
      );
      expect(remittance.journalEntryNo).toBeTruthy();

      const period = submitted.submittedAt.slice(0, 7);
      const reconciliation = await reconcileShaPaymentReport(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: FINANCE,
          kmpdcNumber: fixture.kmpdcNumber,
          reportPeriod: period,
          reportRef: "SHA-PAY-E2E",
          shaReportedAmount: "1200.00",
          lines: [
            { claimRef: submitted.shaClaimRef, shaAmount: "1000.00" },
            { claimRef: "UNMATCHED-E2E", shaAmount: "200.00", reason: "Manual bank adjustment" },
          ],
        },
        { database: ctx.db },
      );

      expect(reconciliation.lines[0]?.status).toBe("matched");
      expect(reconciliation.lines[1]?.status).toBe("unmatched");
      expect(reconciliation.matchedAmount).toBe("1000.00");
      expect(reconciliation.variance).toBe("200.00");
      expect(reconciliation.journalEntryNo).toBeTruthy();

      const eligibilityRows = await ctx.db
        .select()
        .from(shaEligibilityChecks)
        .where(eq(shaEligibilityChecks.facilityId, fixture.facility.id));
      expect(eligibilityRows).toHaveLength(1);
      expect(await auditCount(fixture.facility.id, "sha_eligibility.verify")).toBe(1);
      expect(await auditCount(fixture.facility.id, "sha_claim.adjudicate")).toBe(1);

      const trial = await getTrialBalance(ctx.db, fixture.facility.id);
      expect(trial.balanced).toBe(true);
      const bank = trial.rows.find((row) => row.code === "1010");
      expect(toCents(bank?.balance ?? "0")).toBe(toCents("1200.00"));
    });
  });

  it("segregation of duties rejects a remittance recorded by the claim approver", async () => {
    await withShaFacility(async (fixture) => {
      const setup = await setupEmpanelmentAndPackage(fixture);
      const claim = await createSubmittedClaim(fixture, setup);
      await approveClaim(fixture, claim.claimId, "1000.00");
      const detail = await getShaClaim(ctx.db, fixture.facility.id, claim.claimId);

      await expect(
        recordShaRemittance(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: APPROVER,
            claimId: claim.claimId,
            allocations: [{ claimLineId: detail!.lines[0]!.id, amount: "1000.00" }],
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow("The claim approver cannot record a remittance");
    });
  });
});
