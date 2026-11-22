import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  assertFacilityReady,
  createLicenceAlertRule,
  upsertFacilityRegulatoryProfile,
  upsertFacilitySetting,
  upsertIntegrationSetting,
  upsertPractitionerRegistration,
  upsertStatutoryRate,
  upsertSupportServiceLicence,
  updateFacilityLicence,
  verifyPractitionerLicence,
} from "../src/server/commands/regulatory";
import {
  auditLog,
  facilities,
  facilityLicences,
  facilitySettings,
  practitionerRegistrations,
  staffProfiles,
  staffRoleScopes,
  user,
} from "../src/server/db/schema";
import {
  getFacilityReadinessStatus,
  getFacilitySetting,
  getIntegrationSetting,
  listExpiringLicences,
} from "../src/server/queries/regulatory";
import { cleanupTestFacility, createTestDatabase, insertTestActor, insertTestFacility } from "./helpers";

const { db, pool } = createTestDatabase();

afterAll(async () => {
  await pool.end();
});

function code(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function makeFacility(prefix = "REGT") {
  const facility = await insertTestFacility(db);
  await db.update(facilities).set({ code: code(prefix), writeAuthority: "cloud" }).where(eq(facilities.id, facility.id));
  const actorId = await insertTestActor(db);
  await db.insert(staffRoleScopes).values({ userId: actorId, role: "admin", facilityId: facility.id, branchId: null });
  return { facilityId: facility.id, actorId };
}

async function makeStaff(facilityId: string, role: "admin" | "regulatory_officer" | "cashier" = "regulatory_officer") {
  const id = newId();
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  await db.insert(user).values({ id, name: `Staff ${suffix}`, email: `staff-${suffix}@test.local`, emailVerified: true, role, createdAt: now, updatedAt: now });
  const profileId = newId();
  await db.insert(staffProfiles).values({ id: profileId, userId: id, staffNumber: `ST-${suffix}`.toUpperCase(), createdAt: now, updatedAt: now });
  await db.insert(staffRoleScopes).values({ userId: id, role, facilityId, branchId: null });
  return { userId: id, staffProfileId: profileId };
}

function cmd<T extends Record<string, unknown>>(facilityId: string, actorId: string, extra: T = {} as T) {
  return { facilityId, idempotencyKey: newIdempotencyKey(), actor: { userId: actorId, deviceId: "vitest" }, ...extra };
}

const today = "2026-11-22";
const plusDays = (n: number) => {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("Phase 18 regulatory rules", () => {
  it("1. KRA PIN format is enforced", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await expect(
        upsertFacilityRegulatoryProfile(cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", kraPin: "BADPIN" }), { database: db }),
      ).rejects.toThrow(/KRA PIN/i);
      const ok = await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", kraPin: "p052292910q" }),
        { database: db },
      );
      expect(ok.kraPin).toBe("P052292910Q");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("2. KEPH level must be 1-6", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await expect(
        upsertFacilityRegulatoryProfile(cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", kephLevel: 0 }), { database: db }),
      ).rejects.toThrow(/KEPH/i);
      await expect(
        upsertFacilityRegulatoryProfile(cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", kephLevel: 7 }), { database: db }),
      ).rejects.toThrow(/KEPH/i);
      const ok = await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", kephLevel: 4 }),
        { database: db },
      );
      expect(ok.kephLevel).toBe(4);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("3. licence status is derived correctly from expiry date", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const expired = await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", licenceExpiryDate: plusDays(-1) }),
        { database: db },
      );
      expect(expired.licenceStatus).toBe("expired");
      const expiring = await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", licenceExpiryDate: plusDays(10) }),
        { database: db },
      );
      expect(expiring.licenceStatus).toBe("expiring");
      const active = await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", licenceExpiryDate: plusDays(90) }),
        { database: db },
      );
      expect(active.licenceStatus).toBe("active");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("4. facility licence expiring in 30 days reports expiring; expired reports expired", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", licenceExpiryDate: plusDays(30) }),
        { database: db },
      );
      let readiness = await getFacilityReadinessStatus(db, facilityId, { today });
      expect(readiness.domains.find((d) => d.domain === "kmpdc")?.status).toBe("expiring");

      await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", licenceExpiryDate: plusDays(-5) }),
        { database: db },
      );
      readiness = await getFacilityReadinessStatus(db, facilityId, { today });
      expect(readiness.domains.find((d) => d.domain === "kmpdc")?.status).toBe("expired");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("5. readiness returns expired for past expiry and missing where no record exists", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      let readiness = await getFacilityReadinessStatus(db, facilityId, { today });
      expect(readiness.domains.find((d) => d.domain === "kmpdc")?.status).toBe("missing");
      expect(readiness.domains.find((d) => d.domain === "sha")?.status).toBe("missing");

      await upsertFacilityRegulatoryProfile(
        cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", licenceExpiryDate: plusDays(-1) }),
        { database: db },
      );
      readiness = await getFacilityReadinessStatus(db, facilityId, { today });
      expect(readiness.domains.find((d) => d.domain === "kmpdc")?.status).toBe("expired");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("6. practitioner registration is unique per (facility, practitioner, regulator); duplicate upsert updates", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const staff = await makeStaff(facilityId, "regulatory_officer");
      const first = await upsertPractitionerRegistration(
        cmd(facilityId, actorId, {
          staffProfileId: staff.staffProfileId,
          regulator: "kmpdc",
          profession: "doctor",
          registrationNo: "REG-1",
          licenceExpiryDate: plusDays(60),
        }),
        { database: db },
      );
      const second = await upsertPractitionerRegistration(
        cmd(facilityId, actorId, {
          staffProfileId: staff.staffProfileId,
          regulator: "kmpdc",
          profession: "doctor",
          registrationNo: "REG-2",
          licenceExpiryDate: plusDays(120),
        }),
        { database: db },
      );
      expect(second.registrationId).toBe(first.registrationId);
      const rows = await db
        .select()
        .from(practitionerRegistrations)
        .where(and(eq(practitionerRegistrations.facilityId, facilityId), eq(practitionerRegistrations.staffProfileId, staff.staffProfileId)));
      expect(rows).toHaveLength(1);
      expect(rows[0].registrationNo).toBe("REG-2");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("7. only admin/regulatory_officer can verify a practitioner licence; cashier gets 403", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const staff = await makeStaff(facilityId, "regulatory_officer");
      const reg = await upsertPractitionerRegistration(
        cmd(facilityId, actorId, {
          staffProfileId: staff.staffProfileId,
          regulator: "kmpdc",
          profession: "doctor",
          registrationNo: "REG-1",
          licenceExpiryDate: plusDays(60),
        }),
        { database: db },
      );
      const cashier = await makeStaff(facilityId, "cashier");
      await expect(
        verifyPractitionerLicence(cmd(facilityId, cashier.userId, { registrationId: reg.registrationId }), { database: db }),
      ).rejects.toThrow(/forbidden|Only|admin|regulatory_officer/i);

      const verifier = await makeStaff(facilityId, "regulatory_officer");
      const verified = await verifyPractitionerLicence(
        cmd(facilityId, verifier.userId, { registrationId: reg.registrationId }),
        { database: db },
      );
      expect(verified.verifiedBy).toBe(verifier.userId);
      expect(verified.verifiedAt).toBeTruthy();
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("8. a licence alert rule with no notify roles is rejected", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await expect(
        createLicenceAlertRule(
          cmd(facilityId, actorId, { subjectType: "facility", warnDays: [30], blockDays: [0], notifyRoles: [] }),
          { database: db },
        ),
      ).rejects.toThrow();
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("9. renewing a facility licence appends a new row and preserves the previous row", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const first = await updateFacilityLicence(
        cmd(facilityId, actorId, { licenceType: "kmpdc_facility", licenceNo: "LIC-1", issueDate: "2025-01-01", expiryDate: "2026-01-01" }),
        { database: db },
      );
      const renewed = await updateFacilityLicence(
        cmd(facilityId, actorId, {
          licenceType: "kmpdc_facility",
          licenceNo: "LIC-2",
          issueDate: "2026-01-02",
          expiryDate: "2027-01-01",
          supersedesId: first.licenceId,
        }),
        { database: db },
      );
      expect(renewed.licenceId).not.toBe(first.licenceId);
      const rows = await db.select().from(facilityLicences).where(eq(facilityLicences.facilityId, facilityId));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.licenceNo).sort()).toEqual(["LIC-1", "LIC-2"]);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("10. listExpiringLicences returns exactly rows inside the requested window", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await upsertSupportServiceLicence(
        cmd(facilityId, actorId, { serviceType: "pharmacy", licenceNo: "PPB-IN", expiryDate: plusDays(10), regulator: "ppb", issuingAuthority: "PPB" }),
        { database: db },
      );
      await upsertSupportServiceLicence(
        cmd(facilityId, actorId, { serviceType: "laboratory", licenceNo: "KMLTTB-OUT", expiryDate: plusDays(40), regulator: "kmlttb", issuingAuthority: "KMLTTB" }),
        { database: db },
      );
      const rows = await listExpiringLicences(db, facilityId, { withinDays: 30, today });
      expect(rows.some((r) => r.reference === "PPB-IN")).toBe(true);
      expect(rows.some((r) => r.reference === "KMLTTB-OUT")).toBe(false);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("11. command replay with same idempotency key returns original result and creates no second row", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const request = cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands", kraPin: "P052292910Q" });
      const first = await upsertFacilityRegulatoryProfile(request, { database: db });
      const replay = await upsertFacilityRegulatoryProfile(request, { database: db });
      expect(replay).toEqual(first);
      const profileCount = await db.execute(sql`SELECT count(*)::int AS count FROM facility_regulatory_profiles WHERE facility_id = ${facilityId}::uuid`);
      expect((profileCount as unknown as { rows: Array<{ count: number }> }).rows[0]?.count).toBe(1);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("12. every regulatory write produces an audit row with module='regulatory'", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await upsertFacilityRegulatoryProfile(cmd(facilityId, actorId, { county: "Nairobi", subCounty: "Westlands" }), { database: db });
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.facilityId, facilityId), eq(auditLog.module, "regulatory")));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.module === "regulatory")).toBe(true);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("13. setting value outside allowed_values/min/max/regex is rejected with field error naming the key", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await expect(
        upsertFacilitySetting(cmd(facilityId, actorId, { domain: "regulatory", key: "licence_warn_days", value: 0, effectiveFrom: today }), { database: db }),
      ).rejects.toThrow(/Licence warning window/i);
      await expect(
        upsertFacilitySetting(cmd(facilityId, actorId, { domain: "regulatory", key: "enforcement_mode", value: "nope", effectiveFrom: today }), { database: db }),
      ).rejects.toThrow(/Enforcement mode/i);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("14. required setting left unset makes readiness report missing for its domain, and dependent command names the missing key", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      // billing requires tax.invoice_prefix. Remove seeded default to simulate unset.
      await db.delete(facilitySettings).where(and(eq(facilitySettings.facilityId, facilityId), eq(facilitySettings.domain, "tax"), eq(facilitySettings.key, "invoice_prefix")));
      const decision = await assertFacilityReady({ facilityId, action: "billing", actor: { userId: actorId, deviceId: "vitest" }, today }, { database: db }).catch((e) => e);
      if (decision instanceof Error) {
        expect(String(decision.message)).toMatch(/tax\.invoice_prefix|invoice_prefix/i);
      } else {
        expect(decision.allowed).toBe(false);
        expect(decision.missingSettings).toContain("tax.invoice_prefix");
      }
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("15. setting change is effective-dated and audited with old and new value; reading past date returns value in force then", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      // Remove seeded row so effective dating is deterministic in this test.
      await db.delete(facilitySettings).where(and(eq(facilitySettings.facilityId, facilityId), eq(facilitySettings.domain, "regulatory"), eq(facilitySettings.key, "licence_warn_days")));
      await upsertFacilitySetting(cmd(facilityId, actorId, { domain: "regulatory", key: "licence_warn_days", value: 30, effectiveFrom: "2026-01-01" }), { database: db });
      await upsertFacilitySetting(cmd(facilityId, actorId, { domain: "regulatory", key: "licence_warn_days", value: 45, effectiveFrom: "2026-06-01" }), { database: db });
      const old = await getFacilitySetting(db, facilityId, "regulatory", "licence_warn_days", "2026-03-01");
      const current = await getFacilitySetting(db, facilityId, "regulatory", "licence_warn_days", "2026-11-22");
      expect(Number(old?.valueNumeric ?? old?.valueText)).toBe(30);
      expect(Number(current?.valueNumeric ?? current?.valueText)).toBe(45);
      const auditRows = await db.select().from(auditLog).where(and(eq(auditLog.facilityId, facilityId), eq(auditLog.action, "regulatory.setting.upsert")));
      expect(auditRows.length).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("16. secret setting returns only credential_ref; no query/API response contains secret value", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      const result = await upsertIntegrationSetting(
        cmd(facilityId, actorId, { integration: "etims", environment: "sandbox", baseUrl: "https://etims.example.test", credentialRef: "ETIMS_SANDBOX_SECRET", mode: "oscu" }),
        { database: db },
      );
      expect(result).not.toHaveProperty("credentialValue");
      const row = await getIntegrationSetting(db, facilityId, "etims", "sandbox");
      expect(row?.credentialRef).toBe("ETIMS_SANDBOX_SECRET");
      expect(JSON.stringify(row)).not.toContain("super-secret");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("17. two statutory rate rows for same (rate_type, band_order) cannot overlap in effective dates", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await upsertStatutoryRate(
        cmd(facilityId, actorId, { rateType: "paye_band", bandOrder: 1, lowerBound: "0.00", upperBound: "24000.00", ratePercent: 10, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }),
        { database: db },
      );
      await expect(
        upsertStatutoryRate(
          cmd(facilityId, actorId, { rateType: "paye_band", bandOrder: 1, lowerBound: "0.00", upperBound: "24000.00", ratePercent: 12, effectiveFrom: "2026-06-01", effectiveTo: "2027-06-01" }),
          { database: db },
        ),
      ).rejects.toThrow(/overlap|covers that period/i);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("18. integration setting sandbox is never returned when production requested and vice versa", async () => {
    const { facilityId, actorId } = await makeFacility();
    try {
      await upsertIntegrationSetting(
        cmd(facilityId, actorId, { integration: "etims", environment: "sandbox", baseUrl: "https://sandbox.example.test", credentialRef: "ETIMS_SANDBOX", mode: "oscu" }),
        { database: db },
      );
      await upsertIntegrationSetting(
        cmd(facilityId, actorId, { integration: "etims", environment: "production", baseUrl: "https://prod.example.test", credentialRef: "ETIMS_PROD", mode: "oscu" }),
        { database: db },
      );
      const sandbox = await getIntegrationSetting(db, facilityId, "etims", "sandbox");
      const production = await getIntegrationSetting(db, facilityId, "etims", "production");
      expect(sandbox?.environment).toBe("sandbox");
      expect(production?.environment).toBe("production");
      expect(sandbox?.baseUrl).toContain("sandbox");
      expect(production?.baseUrl).toContain("prod");
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });

  it("19. every key listed in regulatory settings has seeded row after seedRegulatoryDefaults; fresh facility reports missing never error", async () => {
    const { facilityId } = await makeFacility();
    try {
      const { seedRegulatoryDefaults } = await import("../src/server/regulatory-seed");
      await seedRegulatoryDefaults(db, facilityId);
      const { REGULATORY_SETTINGS } = await import("../src/lib/regulatory");
      for (const def of REGULATORY_SETTINGS) {
        const row = await getFacilitySetting(db, facilityId, def.domain as never, def.key);
        expect(row, `missing seeded setting ${def.domain}.${def.key}`).toBeTruthy();
      }
      const readiness = await getFacilityReadinessStatus(db, facilityId, { today });
      expect(readiness.domains.length).toBeGreaterThan(0);
      // missing is acceptable; thrown error is not
      expect(readiness.domains.every((d) => ["compliant", "expiring", "expired", "missing"].includes(d.status))).toBe(true);
    } finally {
      await cleanupTestFacility(db, facilityId);
    }
  });
});
