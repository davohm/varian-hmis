import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { registerPatient } from "../src/server/commands/patients";
import {
  assertMinorTreatmentConsent,
  assertSharingAgreementUsable,
  assertValidPayerSharingConsent,
  completeDataSubjectRequest,
  createDataSubjectRequest,
  createSharingAgreement,
  exportPatientData,
  logChartAccess,
  notifyBreach,
  PrivacyRefusalError,
  recordBreach,
  recordConsent,
  recordTransferAssessment,
  restrictPatientRecord,
  withdrawConsent,
} from "../src/server/commands/privacy";
import {
  auditLog,
  chartAccessLog,
  dataConsents,
  dataSubjectRequests,
  encounters,
  facilitySettings,
  patients,
  payers,
  retentionPolicies,
  staffRoleScopes,
  syncOutbox,
} from "../src/server/db/schema";
import { isConsentValid, PATIENT_RESTRICTION_ENTITY } from "../src/lib/privacy";
import {
  getConsentStatus,
  listConsents,
  listOverdueBreaches,
} from "../src/server/queries/privacy";
import { createClaim } from "../src/server/commands/revenue";
import {
  cleanupTestFacility,
  createTestDatabase,
  deleteTestActor,
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

interface FacilityScope {
  facility: { id: string; code: string };
}

function actor(userId: string) {
  return { userId, ip: "127.0.0.1", deviceId: "vitest-privacy" };
}

async function withFacility<T>(run: (scope: FacilityScope) => Promise<T>): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  try {
    return await run({ facility });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

async function createPatient(
  facilityId: string,
  overrides: {
    firstName?: string;
    lastName?: string;
    dob?: string;
    sex?: "male" | "female" | "other";
    nextOfKin?: Array<{ name: string; relationship: string; phone?: string | null }>;
    minorConsent?: {
      consentType: "minor";
      consentVersion: string;
      granted: true;
      grantedAt: string;
      grantedBy: string;
      source?: string | null;
      consentTextHash?: string | null;
      documentId?: string | null;
      validFrom?: string | null;
      validTo?: string | null;
    };
  } = {},
) {
  return registerPatient(
    {
      facilityId,
      idempotencyKey: newIdempotencyKey(),
      firstName: overrides.firstName ?? "Jane",
      lastName: overrides.lastName ?? "Doe",
      dob: overrides.dob ?? "1990-01-01",
      sex: overrides.sex ?? "female",
      actor: { userId: "vitest" },
      nextOfKin: overrides.nextOfKin ?? [],
      ...(overrides.minorConsent ? { minorConsent: overrides.minorConsent } : {}),
    },
    { database: ctx.db },
  );
}

async function grantScope(userId: string, facilityId: string, role: "admin" | "dpo" | "receptionist" | "doctor") {
  await ctx.db.insert(staffRoleScopes).values({
    userId,
    role,
    facilityId,
    branchId: null,
  });
}

describe("privacy commands and rules", () => {
  it("records consent, supersedes prior version, writes audit/outbox, and replays idempotently", async () => {
    await withFacility(async ({ facility }) => {
      const patient = await createPatient(facility.id);
      const userId = await insertTestActor(ctx.db);
      try {
        const firstKey = newIdempotencyKey();
        const first = await recordConsent(
          {
            facilityId: facility.id,
            idempotencyKey: firstKey,
            actor: actor(userId),
            patientId: patient.patientId,
            consentType: "treatment",
            consentVersion: "v1",
            granted: true,
            grantedAt: new Date().toISOString(),
            source: "reception",
          },
          { database: ctx.db },
        );

        const replay = await recordConsent(
          {
            facilityId: facility.id,
            idempotencyKey: firstKey,
            actor: actor(userId),
            patientId: patient.patientId,
            consentType: "treatment",
            consentVersion: "v1",
            granted: true,
            grantedAt: new Date().toISOString(),
          },
          { database: ctx.db },
        );
        expect(replay).toEqual(first);

        const second = await recordConsent(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            consentType: "treatment",
            consentVersion: "v2",
            granted: true,
            grantedAt: new Date().toISOString(),
          },
          { database: ctx.db },
        );
        expect(second.supersededConsentIds).toContain(first.consentId);

        const rows = await ctx.db
          .select()
          .from(dataConsents)
          .where(
            and(
              eq(dataConsents.facilityId, facility.id),
              eq(dataConsents.patientId, patient.patientId),
              eq(dataConsents.consentType, "treatment"),
            ),
          );
        expect(rows).toHaveLength(2);
        const v1 = rows.find((r) => r.consentVersion === "v1")!;
        const v2 = rows.find((r) => r.consentVersion === "v2")!;
        expect(v1.validTo).not.toBeNull();
        expect(new Date(v1.validTo!).getTime()).toBeLessThanOrEqual(Date.now());
        expect(isConsentValid(v1, new Date())).toBe(false);
        expect(isConsentValid(v2, new Date())).toBe(true);

        const status = await getConsentStatus(ctx.db, facility.id, patient.patientId, "treatment");
        expect(status.status).toBe("valid");
        expect(status.currentConsentId).toBe(v2.id);

        const audits = await ctx.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.facilityId, facility.id), eq(auditLog.action, "privacy.consent.record")));
        expect(audits.length).toBeGreaterThanOrEqual(2);

        const outbox = await ctx.db
          .select()
          .from(syncOutbox)
          .where(and(eq(syncOutbox.facilityId, facility.id), eq(syncOutbox.tableName, "data_consents")));
        expect(outbox.length).toBeGreaterThanOrEqual(2);

        const listed = await listConsents(ctx.db, facility.id, { patientId: patient.patientId });
        expect(listed.find((c) => c.id === v2.id)?.isValid).toBe(true);
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("withdraws consent immediately and cannot be un-withdrawn", async () => {
    await withFacility(async ({ facility }) => {
      const patient = await createPatient(facility.id);
      const userId = await insertTestActor(ctx.db);
      try {
        const recorded = await recordConsent(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            consentType: "sms",
            consentVersion: "v1",
            granted: true,
            grantedAt: new Date().toISOString(),
          },
          { database: ctx.db },
        );

        const key = newIdempotencyKey();
        const withdrawn = await withdrawConsent(
          {
            facilityId: facility.id,
            idempotencyKey: key,
            actor: actor(userId),
            consentId: recorded.consentId,
          },
          { database: ctx.db },
        );
        expect(withdrawn.consentId).toBe(recorded.consentId);
        expect(new Date(withdrawn.withdrawnAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

        const replay = await withdrawConsent(
          {
            facilityId: facility.id,
            idempotencyKey: key,
            actor: actor(userId),
            consentId: recorded.consentId,
          },
          { database: ctx.db },
        );
        expect(replay).toEqual(withdrawn);

        await expect(
          withdrawConsent(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(userId),
              consentId: recorded.consentId,
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/un-withdrawn/i);

        const audits = await ctx.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.facilityId, facility.id), eq(auditLog.action, "privacy.consent.withdraw")));
        expect(audits).toHaveLength(1);
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("creates DSAR with due_at based on privacy.dsar_sla_days and requires outcome on completion; erasure restricts without deletion", async () => {
    await withFacility(async ({ facility }) => {
      const patient = await createPatient(facility.id);
      const userId = await insertTestActor(ctx.db);
      try {
        await ctx.db
          .delete(facilitySettings)
          .where(
            and(
              eq(facilitySettings.facilityId, facility.id),
              eq(facilitySettings.domain, "privacy"),
              eq(facilitySettings.key, "dsar_sla_days"),
            ),
          );
        const today = new Date().toISOString().slice(0, 10);
        await ctx.db.insert(facilitySettings).values({
          facilityId: facility.id,
          domain: "privacy",
          key: "dsar_sla_days",
          valueNumeric: "7",
          dataType: "integer",
          effectiveFrom: today,
          createdBy: "vitest",
        });

        const receivedAt = "2026-01-10T08:00:00.000Z";
        const created = await createDataSubjectRequest(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            requestType: "access",
            receivedAt,
            requestedVia: "email",
          },
          { database: ctx.db },
        );
        expect(created.dueAt.slice(0, 10)).toBe("2026-01-17");

        const erasure = await createDataSubjectRequest(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            requestType: "erasure",
            receivedAt,
          },
          { database: ctx.db },
        );

        await expect(
          completeDataSubjectRequest(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(userId),
              requestId: created.requestId,
              status: "completed",
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/Outcome/i);

        const completedErasure = await completeDataSubjectRequest(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            requestId: erasure.requestId,
            status: "completed",
            outcome: "Erased where lawful; retained statutory minimum.",
          },
          { database: ctx.db },
        );
        expect(completedErasure.restrictionCreated).toBe(true);

        const restrictions = await ctx.db
          .select()
          .from(retentionPolicies)
          .where(
            and(
              eq(retentionPolicies.facilityId, facility.id),
              eq(retentionPolicies.entity, PATIENT_RESTRICTION_ENTITY),
              eq(retentionPolicies.triggerEvent, patient.patientId),
            ),
          );
        expect(restrictions.length).toBeGreaterThanOrEqual(1);
        expect(restrictions[0].legalHold).toBe(true);

        const patientRows = await ctx.db
          .select({ id: patients.id })
          .from(patients)
          .where(eq(patients.id, patient.patientId));
        expect(patientRows).toHaveLength(1);

        const dsarRows = await ctx.db
          .select()
          .from(dataSubjectRequests)
          .where(eq(dataSubjectRequests.id, erasure.requestId));
        expect(dsarRows[0].outcome).toContain("Erased");
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("enforces breach notification timing and surfaces high-severity unnotified breaches", async () => {
    await withFacility(async ({ facility }) => {
      const userId = await insertTestActor(ctx.db);
      try {
        const discoveredAt = "2026-05-10T10:00:00.000Z";
        await expect(
          recordBreach(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(userId),
              discoveredAt,
              odpcNotifiedAt: "2026-05-09T10:00:00.000Z",
              affectedSubjects: 5,
              severity: "high",
              status: "open",
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/before discovery/i);

        const breach = await recordBreach(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            discoveredAt,
            affectedSubjects: 5,
            severity: "high",
            status: "open",
            description: "Laptop loss",
          },
          { database: ctx.db },
        );

        const overdue = await listOverdueBreaches(ctx.db, facility.id);
        expect(overdue.map((b) => b.id)).toContain(breach.breachId);

        await expect(
          notifyBreach(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(userId),
              breachId: breach.breachId,
              odpcNotifiedAt: "2026-05-09T10:00:00.000Z",
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/before discovery/i);

        const notified = await notifyBreach(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            breachId: breach.breachId,
            odpcNotifiedAt: "2026-05-11T10:00:00.000Z",
            odpcReference: "ODPC-REF-1",
          },
          { database: ctx.db },
        );
        expect(notified.odpcReference).toBe("ODPC-REF-1");

        const overdueAfter = await listOverdueBreaches(ctx.db, facility.id);
        expect(overdueAfter.map((b) => b.id)).not.toContain(breach.breachId);
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("rejects expired or inactive sharing agreements for new payer share and records refusal for missing payer consent", async () => {
    await withFacility(async ({ facility }) => {
      const userId = await insertTestActor(ctx.db);
      const patient = await createPatient(facility.id);
      try {
        await grantScope(userId, facility.id, "admin");

        const expired = await createSharingAgreement(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            counterparty: "Old Payer",
            counterpartyType: "payer",
            lawfulBasis: "Contract",
            startedOn: "2020-01-01",
            expiresOn: "2020-12-31",
            status: "active",
          },
          { database: ctx.db },
        );

        const inactive = await createSharingAgreement(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            counterparty: "Suspended Payer",
            counterpartyType: "payer",
            lawfulBasis: "Contract",
            startedOn: "2026-01-01",
            expiresOn: "2030-12-31",
            status: "suspended",
          },
          { database: ctx.db },
        );

        await ctx.db.transaction(async (tx) => {
          await expect(
            assertSharingAgreementUsable(tx, facility.id, expired.agreementId, "2026-06-01"),
          ).rejects.toBeInstanceOf(PrivacyRefusalError);
          await expect(
            assertSharingAgreementUsable(tx, facility.id, inactive.agreementId, "2026-06-01"),
          ).rejects.toBeInstanceOf(PrivacyRefusalError);
        });

        await ctx.db.transaction(async (tx) => {
          await expect(
            assertValidPayerSharingConsent(tx, {
              facilityId: facility.id,
              patientId: patient.patientId,
              actor: actor(userId),
              action: "billing.invoice.share_refused_test",
              entity: "invoices",
              entityId: newId(),
              sharingAgreementId: expired.agreementId,
            }),
          ).rejects.toBeInstanceOf(PrivacyRefusalError);
        });

        // Expired agreement refusal audited by assertValidPayerSharingConsent path? it throws on agreement check before consent lookup,
        // but missing consent path must also throw+audit refusal.
        await ctx.db.transaction(async (tx) => {
          await expect(
            assertValidPayerSharingConsent(tx, {
              facilityId: facility.id,
              patientId: patient.patientId,
              actor: actor(userId),
              action: "billing.invoice.share_refused_missing_consent",
              entity: "invoices",
              entityId: newId(),
            }),
          ).rejects.toThrow(/valid payer sharing consent/i);
        });

        const refusalAudits = await ctx.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.facilityId, facility.id),
              eq(auditLog.action, "billing.invoice.share_refused_missing_consent"),
            ),
          );
        expect(refusalAudits.length).toBeGreaterThanOrEqual(1);
        expect(refusalAudits[0].details).toMatchObject({ refused: true });
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("requires guardian/minor consent for minor treatment and minor registration", async () => {
    await withFacility(async ({ facility }) => {
      const userId = await insertTestActor(ctx.db);
      try {
        await expect(
          createPatient(facility.id, { dob: "2015-05-01" }),
        ).rejects.toThrow(/guardian|next of kin/i);

        await expect(
          createPatient(facility.id, {
            dob: "2015-05-01",
            nextOfKin: [{ name: "Guardian One", relationship: "Mother", phone: "+254700000001" }],
          }),
        ).rejects.toThrow(/guardian consent/i);

        const grantedAt = new Date().toISOString();
        const minor = await createPatient(facility.id, {
          dob: "2015-05-01",
          nextOfKin: [{ name: "Guardian One", relationship: "Mother", phone: "+254700000001" }],
          minorConsent: {
            consentType: "minor",
            consentVersion: "guardian-v1",
            granted: true,
            grantedAt,
            grantedBy: "Guardian One",
            source: "registration",
          },
        });
        const adult = await createPatient(facility.id, { dob: "1990-05-01" });

        await ctx.db.transaction(async (tx) => {
          const okMinor = await assertMinorTreatmentConsent(tx, {
            facilityId: facility.id,
            patientId: minor.patientId,
            actor: actor(userId),
          });
          expect(okMinor).not.toBeNull();
          const okAdult = await assertMinorTreatmentConsent(tx, {
            facilityId: facility.id,
            patientId: adult.patientId,
          });
          expect(okAdult).toBeNull();
        });

        const minorConsents = await ctx.db
          .select()
          .from(dataConsents)
          .where(
            and(
              eq(dataConsents.facilityId, facility.id),
              eq(dataConsents.patientId, minor.patientId),
              eq(dataConsents.consentType, "minor"),
            ),
          );
        expect(minorConsents.length).toBeGreaterThanOrEqual(1);

        const audits = await ctx.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.facilityId, facility.id),
              eq(auditLog.action, "privacy.consent.record"),
              eq(auditLog.entity, "data_consents"),
            ),
          );
        expect(audits.some((a) => (a.details as Record<string, unknown> | null)?.patientId === minor.patientId)).toBe(true);
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("refuses claim creation through revenue without valid payer sharing consent", async () => {
    await withFacility(async ({ facility }) => {
      const userId = await insertTestActor(ctx.db);
      try {
        await grantScope(userId, facility.id, "admin");
        const patient = await createPatient(facility.id);
        const branchId = await insertTestBranch(ctx.db, facility.id);
        const encounterId = newId();
        await ctx.db.insert(encounters).values({
          id: encounterId,
          facilityId: facility.id,
          branchId,
          patientId: patient.patientId,
          encounterNo: `ENC-${randomUUID().slice(0, 8).toUpperCase()}`,
          status: "open",
          payerType: "cash",
          startedAt: new Date(),
          createdBy: userId,
        });
        const payerId = newId();
        await ctx.db.insert(payers).values({
          id: payerId,
          facilityId: facility.id,
          code: `PY-${randomUUID().slice(0, 6).toUpperCase()}`,
          name: "Test Insurer",
          kind: "insurer",
          active: true,
          createdBy: userId,
        });

        await expect(
          createClaim(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(userId),
              payerId,
              patientId: patient.patientId,
              encounterId,
              lines: [{ description: "Consultation", amount: "500.00" }],
            },
            { database: ctx.db },
          ),
        ).rejects.toBeInstanceOf(PrivacyRefusalError);

        const refusalAudits = await ctx.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.facilityId, facility.id),
              eq(auditLog.action, "revenue.claim.create_refused"),
            ),
          );
        expect(refusalAudits.length).toBeGreaterThanOrEqual(1);

        await recordConsent(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            consentType: "payer_sharing",
            consentVersion: "v1",
            granted: true,
            grantedAt: new Date().toISOString(),
            grantedBy: "Patient",
          },
          { database: ctx.db },
        );

        const claim = await createClaim(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            payerId,
            patientId: patient.patientId,
            encounterId,
            lines: [{ description: "Consultation", amount: "500.00" }],
          },
          { database: ctx.db },
        );
        expect(claim.status).toBe("draft");
        expect(claim.lineCount).toBe(1);
        expect(claim.claimId).toBeTruthy();
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("restricts patient, requires reason for restricted chart access, and logs chart access", async () => {
    await withFacility(async ({ facility }) => {
      const userId = await insertTestActor(ctx.db);
      const patient = await createPatient(facility.id);
      try {
        await grantScope(userId, facility.id, "doctor");

        const restriction = await restrictPatientRecord(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            reason: "Sensitive case",
          },
          { database: ctx.db },
        );
        expect(restriction.restricted).toBe(true);

        await expect(
          logChartAccess(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(userId),
              patientId: patient.patientId,
              accessType: "view",
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/reason is required/i);

        const logged = await logChartAccess(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            patientId: patient.patientId,
            accessType: "view",
            reason: "Clinical care",
          },
          { database: ctx.db },
        );
        expect(logged.restricted).toBe(true);

        const accessRows = await ctx.db
          .select()
          .from(chartAccessLog)
          .where(and(eq(chartAccessLog.facilityId, facility.id), eq(chartAccessLog.patientId, patient.patientId)));
        expect(accessRows).toHaveLength(1);
        expect(accessRows[0].reason).toBe("Clinical care");

        const accessAudits = await ctx.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.facilityId, facility.id), eq(auditLog.action, "privacy.chart_access.log")));
        expect(accessAudits).toHaveLength(1);
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });

  it("exports patient data completely for dpo/admin only and is idempotent", async () => {
    await withFacility(async ({ facility }) => {
      const dpoUser = await insertTestActor(ctx.db);
      const otherUser = await insertTestActor(ctx.db);
      const patient = await createPatient(facility.id);
      try {
        await grantScope(dpoUser, facility.id, "dpo");
        await grantScope(otherUser, facility.id, "receptionist");

        await recordConsent(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(dpoUser),
            patientId: patient.patientId,
            consentType: "data_processing",
            consentVersion: "v1",
            granted: true,
            grantedAt: new Date().toISOString(),
          },
          { database: ctx.db },
        );

        await expect(
          exportPatientData(
            {
              facilityId: facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: actor(otherUser),
              patientId: patient.patientId,
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/data protection officer|administrator/i);

        const key = newIdempotencyKey();
        const exported = await exportPatientData(
          {
            facilityId: facility.id,
            idempotencyKey: key,
            actor: actor(dpoUser),
            patientId: patient.patientId,
          },
          { database: ctx.db },
        );
        expect(exported.patientId).toBe(patient.patientId);
        expect(exported.data.patient).toMatchObject({ id: patient.patientId });
        expect(exported.counts).toHaveProperty("encounters");
        expect(exported.counts).toHaveProperty("invoices");
        expect(exported.counts).toHaveProperty("payments");
        expect(exported.counts).toHaveProperty("consents");
        expect(exported.counts).toHaveProperty("audit");
        expect(exported.counts.consents).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(exported.data.encounters)).toBe(true);
        expect(Array.isArray(exported.data.invoices)).toBe(true);
        expect(Array.isArray(exported.data.payments)).toBe(true);
        expect(Array.isArray(exported.data.consents)).toBe(true);
        expect(Array.isArray(exported.data.audit)).toBe(true);

        const replay = await exportPatientData(
          {
            facilityId: facility.id,
            idempotencyKey: key,
            actor: actor(dpoUser),
            patientId: patient.patientId,
          },
          { database: ctx.db },
        );
        expect(JSON.parse(JSON.stringify(replay))).toEqual(JSON.parse(JSON.stringify(exported)));

        const exportAudits = await ctx.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.facilityId, facility.id), eq(auditLog.action, "privacy.data.export")));
        expect(exportAudits).toHaveLength(1);
      } finally {
        await deleteTestActor(ctx.db, dpoUser);
        await deleteTestActor(ctx.db, otherUser);
      }
    });
  });

  it("records transfer assessment and creates sharing agreement audit/outbox", async () => {
    await withFacility(async ({ facility }) => {
      const userId = await insertTestActor(ctx.db);
      try {
        const agreement = await createSharingAgreement(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            counterparty: "Cloud Processor",
            counterpartyType: "processor",
            lawfulBasis: "DPA",
            expiresOn: "2030-01-01",
          },
          { database: ctx.db },
        );
        expect(agreement.agreementId).toBeTruthy();

        const assessment = await recordTransferAssessment(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actor(userId),
            destinationCountry: "Ireland",
            mechanism: "SCCs",
            reviewDate: "2027-01-01",
          },
          { database: ctx.db },
        );
        expect(assessment.destinationCountry).toBe("Ireland");

        const outbox = await ctx.db
          .select()
          .from(syncOutbox)
          .where(eq(syncOutbox.facilityId, facility.id));
        expect(outbox.some((r) => r.tableName === "data_sharing_agreements")).toBe(true);
        expect(outbox.some((r) => r.tableName === "transfer_assessments")).toBe(true);
      } finally {
        await deleteTestActor(ctx.db, userId);
      }
    });
  });
});
