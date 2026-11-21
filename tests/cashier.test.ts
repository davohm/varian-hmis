import { and, asc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RECEIPT_WIDTH_CHARS,
  RECEIPT_WIDTH_MM,
  fromCents,
  invoiceStatus,
  lineAmount,
  outstandingAmount,
  renderReceiptText,
  sessionExpectedCash,
  sumAmounts,
  toCents,
  validateTenders,
  varianceAmount,
  type ReceiptData,
} from "../src/lib/billing";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  closeCashierSession,
  openCashierSession,
  openInvoice,
  reversePayment,
  takePayment,
  voidInvoice,
} from "../src/server/commands/billing";
import {
  cancelLabOrder,
  orderLabTests,
  prescribe,
  startConsultation,
} from "../src/server/commands/clinical";
import { startVisit } from "../src/server/commands/encounters";
import { registerPatient, type RegisterPatientInput } from "../src/server/commands/patients";
import { dispensePrescription, receiveStock, reverseDispense } from "../src/server/commands/pharmacy";
import { queuePatient } from "../src/server/commands/queue";
import { recordTriageVitals } from "../src/server/commands/triage";
import {
  charges,
  invoices,
  items,
  labTests,
  payments,
  priceLists,
  prices,
  services,
  stores,
} from "../src/server/db/schema";
import { formatNumber } from "../src/server/numbering";
import {
  getCashierQueue,
  getEncounterBill,
  getEndOfDayReport,
  getInvoiceDetail,
  getOpenCashierSession,
  getReceipt,
  listCashierSessions,
  listPriceLists,
} from "../src/server/queries/billing";

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

const ACTOR = { userId: "vitest", deviceId: "cashier-station" };

type Payer = "cash" | "sha" | "insurance";

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

interface CashierFixture {
  facility: { id: string; code: string };
  branchId: string;
  pharmacyStoreId: string;
  labTest: { id: string; code: string; name: string };
  unpricedLabTest: { id: string; code: string; name: string };
  drug: { id: string; code: string; name: string };
  consultationService: { id: string; code: string } | null;
  labService: { id: string; code: string };
  priceListIds: Partial<Record<Payer, string>>;
}

interface CashierFixtureOptions {
  priceLists?: Payer[];
  consultationService?: boolean;
  sharedConsultationPrice?: string | null;
  skipConsultationPrice?: boolean;
  stock?: number;
}

/** Negotiated consultation and laboratory prices per payer. */
const SERVICE_PRICES: Record<Payer, { consultation: string; lab: string }> = {
  cash: { consultation: "1000.00", lab: "800.00" },
  sha: { consultation: "1100.00", lab: "900.00" },
  insurance: { consultation: "1250.00", lab: "1000.00" },
};

/** The insurance list deliberately has no medicine price, so drug lines skip. */
const DRUG_PRICES: Partial<Record<Payer, string>> = {
  cash: "2.00",
  sha: "2.20",
};

/**
 * A facility with its own services, one price list per payer, a laboratory
 * catalogue and a stocked pharmacy, so billing can be exercised end to end
 * without depending on seed data.
 */
async function withCashierFacility<T>(
  run: (fixture: CashierFixture) => Promise<T>,
  options: CashierFixtureOptions = {},
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

  const labTest = { id: newId(), code: `FBC${suffix}`, name: `Full Blood Count ${suffix}` };
  const unpricedLabTest = {
    id: newId(),
    code: `MP${suffix}`,
    name: `Malaria Parasites ${suffix}`,
  };
  const drug = { id: newId(), code: `PARA${suffix}`, name: `Paracetamol ${suffix}` };

  await ctx.db.insert(labTests).values([
    {
      id: labTest.id,
      facilityId: facility.id,
      code: labTest.code,
      name: labTest.name,
      sampleType: "Whole blood (EDTA)",
      parameters: [
        {
          name: "Haemoglobin",
          unit: "g/dL",
          refLow: 12,
          refHigh: 17,
          criticalLow: 7,
          criticalHigh: 20,
        },
      ],
      createdBy: "vitest",
    },
    {
      id: unpricedLabTest.id,
      facilityId: facility.id,
      code: unpricedLabTest.code,
      name: unpricedLabTest.name,
      sampleType: "Whole blood (EDTA)",
      parameters: [
        {
          name: "Parasite density",
          unit: "parasites/uL",
          refLow: null,
          refHigh: 0,
          criticalLow: null,
          criticalHigh: null,
        },
      ],
      createdBy: "vitest",
    },
  ]);

  await ctx.db.insert(items).values({
    id: drug.id,
    facilityId: facility.id,
    code: drug.code,
    name: drug.name,
    kind: "drug",
    unit: "tablet",
    strength: "500 mg",
    form: "Tablet",
    createdBy: "vitest",
  });

  const pharmacyStoreId = newId();
  await ctx.db.insert(stores).values({
    id: pharmacyStoreId,
    facilityId: facility.id,
    branchId,
    name: "Pharmacy",
    kind: "pharmacy",
    createdBy: "vitest",
  });

  const consultationService =
    options.consultationService === false
      ? null
      : { id: newId(), code: `CONS${suffix}`, name: `Consultation ${suffix}` };
  const labService = {
    id: newId(),
    code: labTest.code,
    name: `Laboratory: ${labTest.name}`,
  };

  await ctx.db.insert(services).values([
    ...(consultationService
      ? [
          {
            id: consultationService.id,
            facilityId: facility.id,
            code: consultationService.code,
            name: consultationService.name,
            kind: "consultation" as const,
            defaultPrice: "1000.00",
            createdBy: "vitest",
          },
        ]
      : []),
    {
      id: labService.id,
      facilityId: facility.id,
      code: labService.code,
      name: labService.name,
      kind: "lab" as const,
      defaultPrice: "800.00",
      createdBy: "vitest",
    },
  ]);

  // A shared row with the same code must lose to the facility's own service.
  let sharedServiceId: string | null = null;
  if (options.sharedConsultationPrice && consultationService) {
    sharedServiceId = newId();
    await ctx.db.insert(services).values({
      id: sharedServiceId,
      facilityId: null,
      code: consultationService.code,
      name: `Shared consultation ${suffix}`,
      kind: "consultation",
      defaultPrice: options.sharedConsultationPrice,
      createdBy: "vitest",
    });
  }

  const priceListIds: Partial<Record<Payer, string>> = {};
  for (const payer of options.priceLists ?? ["cash", "sha", "insurance"]) {
    const priceListId = newId();
    priceListIds[payer] = priceListId;
    await ctx.db.insert(priceLists).values({
      id: priceListId,
      facilityId: facility.id,
      name: `${payer} price list`,
      payerType: payer,
      createdBy: "vitest",
    });

    const rows: Array<{
      id: string;
      facilityId: string;
      priceListId: string;
      serviceId: string | null;
      itemId: string | null;
      amount: string;
      createdBy: string;
    }> = [];
    if (consultationService && !options.skipConsultationPrice) {
      rows.push({
        id: newId(),
        facilityId: facility.id,
        priceListId,
        serviceId: consultationService.id,
        itemId: null,
        amount: SERVICE_PRICES[payer].consultation,
        createdBy: "vitest",
      });
    }
    rows.push({
      id: newId(),
      facilityId: facility.id,
      priceListId,
      serviceId: labService.id,
      itemId: null,
      amount: SERVICE_PRICES[payer].lab,
      createdBy: "vitest",
    });
    const drugPrice = DRUG_PRICES[payer];
    if (drugPrice) {
      rows.push({
        id: newId(),
        facilityId: facility.id,
        priceListId,
        serviceId: null,
        itemId: drug.id,
        amount: drugPrice,
        createdBy: "vitest",
      });
    }
    await ctx.db.insert(prices).values(rows);
  }

  await receiveStock(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      storeId: pharmacyStoreId,
      itemId: drug.id,
      batchNo: "BATCH-A",
      expiryDate: null,
      quantity: options.stock ?? 200,
    },
    { database: ctx.db },
  );

  try {
    return await run({
      facility,
      branchId,
      pharmacyStoreId,
      labTest,
      unpricedLabTest,
      drug,
      consultationService,
      labService,
      priceListIds,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
    if (sharedServiceId) {
      await ctx.db.delete(services).where(eq(services.id, sharedServiceId));
    }
  }
}

function patientInput(
  facilityId: string,
  overrides: Partial<RegisterPatientInput> = {},
): RegisterPatientInput {
  return {
    facilityId,
    idempotencyKey: newIdempotencyKey(),
    firstName: "Amina",
    lastName: "Otieno",
    dob: "1990-04-12",
    sex: "female",
    phone: "0712345678",
    nationalId: `ID-${newId().slice(0, 8)}`,
    allergies: [],
    bloodGroup: "O+",
    actor: ACTOR,
    ...overrides,
  };
}

interface CashierVisit {
  patientId: string;
  mrn: string;
  encounterId: string;
  encounterNo: string;
  doctorQueueEntryId: string;
}

/** Register, start a visit and triage it so the doctor can see the patient. */
async function createVisit(
  fixture: CashierFixture,
  options: {
    payerType?: Payer;
    overrides?: Partial<RegisterPatientInput>;
  } = {},
): Promise<CashierVisit> {
  const registered = await registerPatient(
    patientInput(fixture.facility.id, options.overrides),
    { database: ctx.db },
  );
  const visit = await startVisit(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      patientId: registered.patientId,
      branchId: fixture.branchId,
      payerType: options.payerType,
      actor: ACTOR,
    },
    { database: ctx.db },
  );
  const triage = await queuePatient(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      encounterId: visit.encounterId,
      department: "Triage",
      actor: ACTOR,
    },
    { database: ctx.db },
  );
  const vitals = await recordTriageVitals(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      queueEntryId: triage.queueEntryId,
      systolic: 118,
      diastolic: 76,
      heartRate: 72,
      respRate: 16,
      temperature: 36.8,
      spo2: 98,
      weightKg: 64,
      heightCm: 165,
      painScore: 1,
      category: "green",
      chiefComplaint: "Headache for two days",
      comments: "No red flags",
      nextSteps: "Doctor review",
    },
    { database: ctx.db },
  );

  return {
    patientId: registered.patientId,
    mrn: registered.mrn,
    encounterId: visit.encounterId,
    encounterNo: visit.encounterNo,
    doctorQueueEntryId: vitals.doctorQueueEntryId,
  };
}

async function consult(fixture: CashierFixture, visit: CashierVisit) {
  return startConsultation(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      queueEntryId: visit.doctorQueueEntryId,
    },
    { database: ctx.db },
  );
}

async function orderLabs(
  fixture: CashierFixture,
  visit: CashierVisit,
  labTestIds: string[],
) {
  return orderLabTests(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      labTestIds,
    },
    { database: ctx.db },
  );
}

async function prescribeDrug(
  fixture: CashierFixture,
  visit: CashierVisit,
  quantity: number,
) {
  return prescribe(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
      itemId: fixture.drug.id,
      dose: "1 tablet",
      route: "oral",
      frequency: "three times daily",
      durationDays: 5,
      quantity,
      instructions: "Take after food",
    },
    { database: ctx.db },
  );
}

async function dispenseDrug(fixture: CashierFixture, prescriptionId: string) {
  return dispensePrescription(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      prescriptionId,
    },
    { database: ctx.db },
  );
}

async function openSession(fixture: CashierFixture, openingFloat = 0) {
  return openCashierSession(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      openingFloat,
      branchId: fixture.branchId,
    },
    { database: ctx.db },
  );
}

async function bill(fixture: CashierFixture, visit: CashierVisit) {
  return openInvoice(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      encounterId: visit.encounterId,
    },
    { database: ctx.db },
  );
}

async function pay(
  fixture: CashierFixture,
  invoiceId: string,
  tenders: Array<{
    method: "cash" | "mpesa" | "card" | "insurance";
    amount: number;
    reference?: string;
  }>,
) {
  return takePayment(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      invoiceId,
      tenders,
    },
    { database: ctx.db },
  );
}

async function activeCharges(facilityId: string, encounterId: string) {
  return ctx.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.facilityId, facilityId),
        eq(charges.encounterId, encounterId),
        isNull(charges.voidedAt),
      ),
    )
    .orderBy(asc(charges.createdAt));
}

async function invoiceRow(facilityId: string, invoiceId: string) {
  const rows = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.facilityId, facilityId), eq(invoices.id, invoiceId)));
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* Pure money, tender and receipt rules                                */
/* ------------------------------------------------------------------ */

describe("billing rules", () => {
  it("converts money to integer cents and back without float drift", () => {
    expect(toCents("1350.00")).toBe(135_000);
    expect(toCents("1350.5")).toBe(135_050);
    expect(toCents("-2.25")).toBe(-225);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(fromCents(135_000)).toBe("1350.00");
    expect(fromCents(-225)).toBe("-2.25");
    expect(fromCents(toCents("19.99"))).toBe("19.99");
  });

  it("multiplies a unit price by a whole quantity", () => {
    expect(lineAmount("2.00", 5)).toBe("10.00");
    expect(lineAmount("1999.99", 3)).toBe("5999.97");
    expect(sumAmounts(["10.00", "0.50", "-2.25"])).toBe("8.25");
  });

  it("derives the invoice status from the total and what has been paid", () => {
    expect(invoiceStatus("1000.00", "0.00")).toBe("open");
    expect(invoiceStatus("1000.00", "400.00")).toBe("partial");
    expect(invoiceStatus("1000.00", "1000.00")).toBe("paid");
    expect(invoiceStatus("1000.00", "1200.00")).toBe("paid");
    expect(invoiceStatus("0.00", "0.00")).toBe("paid");
  });

  it("never reports a negative outstanding balance", () => {
    expect(outstandingAmount("1000.00", "400.00")).toBe("600.00");
    expect(outstandingAmount("1000.00", "1000.00")).toBe("0.00");
    expect(outstandingAmount("1000.00", "1200.00")).toBe("0.00");
  });

  it("accepts a split tender that fits the balance and rejects overpayment", () => {
    expect(
      validateTenders("1000.00", "0.00", [
        { method: "cash", amount: "600.00" },
        { method: "mpesa", amount: "400.00" },
      ]),
    ).toEqual({ totalCents: 100_000, paidCents: 0, tenderCents: 100_000 });

    expect(() =>
      validateTenders("1000.00", "400.00", [{ method: "cash", amount: "700.00" }]),
    ).toThrow(/exceed the outstanding balance of 600.00/);
    expect(() => validateTenders("1000.00", "0.00", [])).toThrow(/at least one tender/);
    expect(() =>
      validateTenders("1000.00", "1000.00", [{ method: "cash", amount: "100.00" }]),
    ).toThrow(/already fully paid/);
    expect(() =>
      validateTenders("1000.00", "0.00", [{ method: "cheque", amount: "100.00" }]),
    ).toThrow(/Unknown payment method/);
    expect(() =>
      validateTenders("1000.00", "0.00", [{ method: "cash", amount: "0" }]),
    ).toThrow(/greater than zero/);
  });

  it("expects opening float plus net cash only, and measures the variance", () => {
    expect(
      sessionExpectedCash("5000.00", [
        { method: "cash", amount: "600.00" },
        { method: "mpesa", amount: "400.00" },
        { method: "cash", amount: "-600.00" },
      ]),
    ).toBe("5000.00");
    expect(sessionExpectedCash(0, [{ method: "mpesa", amount: "400.00" }])).toBe("0.00");
    expect(varianceAmount("5900.00", "6000.00")).toBe("-100.00");
    expect(varianceAmount("6050.00", "6000.00")).toBe("50.00");
  });

  it("renders a receipt that fits 80 mm paper", () => {
    const receipt: ReceiptData = {
      facilityName: "Family Afya Modern Medical Centre",
      facilityPhone: "0700000000",
      branchName: "Main Branch",
      patientName: "Amina Otieno",
      mrn: "FAM-00001",
      encounterNo: "FAM-E-26-000001",
      invoiceNo: "FAM-I-26-000001",
      receiptNo: "FAM-R-26-000001",
      issuedAt: "2026-11-18T09:30:00.000Z",
      cashier: "Cashier One",
      lines: [
        {
          description:
            "A deliberately long description that should be shortened to fit the thermal paper width",
          quantity: 3,
          unitPrice: "2.00",
          amount: "6.00",
        },
      ],
      total: "1006.00",
      paid: "1006.00",
      outstanding: "0.00",
      payment: { method: "mpesa", amount: "1006.00", reference: "QK7H2XYZ" },
      payments: [
        {
          receiptNo: "FAM-R-26-000001",
          method: "mpesa",
          amount: "1006.00",
          receivedAt: "2026-11-18T09:30:00.000Z",
        },
      ],
    };

    const text = renderReceiptText(receipt);
    expect(RECEIPT_WIDTH_MM).toBe(80);
    expect(RECEIPT_WIDTH_CHARS).toBe(40);
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(RECEIPT_WIDTH_CHARS);
    }
    expect(text).toContain("FAM-R-26-000001");
    expect(text).toContain("M-Pesa");
    expect(text).toContain("3 x 2.00");
    expect(text).toContain("…");
  });
});

/* ------------------------------------------------------------------ */
/* Automatic charges                                                   */
/* ------------------------------------------------------------------ */

describe("automatic charges", () => {
  it("raises one consultation charge and keeps it stable when the bill syncs again", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);

      const first = await activeCharges(fixture.facility.id, visit.encounterId);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        sourceType: "consultation",
        sourceId: visit.encounterId,
        serviceId: fixture.consultationService!.id,
        quantity: 1,
        unitPrice: "1000.00",
        amount: "1000.00",
      });

      await consult(fixture, visit);
      const second = await activeCharges(fixture.facility.id, visit.encounterId);
      expect(second).toHaveLength(1);
    });
  });

  it("adds one line per laboratory test and per dispensed medicine", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      await orderLabs(fixture, visit, [fixture.labTest.id, fixture.unpricedLabTest.id]);
      const prescription = await prescribeDrug(fixture, visit, 5);
      await dispenseDrug(fixture, prescription.prescriptionId);

      const rows = await activeCharges(fixture.facility.id, visit.encounterId);
      expect(rows.map((row) => row.sourceType).sort()).toEqual(["consultation", "drug", "lab"]);

      const lab = rows.find((row) => row.sourceType === "lab")!;
      expect(lab).toMatchObject({ serviceId: fixture.labService.id, quantity: 1, amount: "800.00" });

      const drug = rows.find((row) => row.sourceType === "drug")!;
      expect(drug).toMatchObject({
        sourceId: prescription.prescriptionId,
        itemId: fixture.drug.id,
        quantity: 5,
        unitPrice: "2.00",
        amount: "10.00",
      });

      const invoice = await bill(fixture, visit);
      expect(invoice.total).toBe("1810.00");
      expect(invoice.chargeCount).toBe(3);

      await consult(fixture, visit);
      expect(await activeCharges(fixture.facility.id, visit.encounterId)).toHaveLength(3);
      expect((await invoiceRow(fixture.facility.id, invoice.invoiceId)).total).toBe("1810.00");
    });
  });

  it("skips a laboratory line when the test has no billable service", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await orderLabs(fixture, visit, [fixture.unpricedLabTest.id]);

      const rows = await activeCharges(fixture.facility.id, visit.encounterId);
      expect(rows.map((row) => row.sourceType)).toEqual(["consultation"]);
    });
  });

  it("voids a laboratory line when the order is cancelled before payment", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const order = await orderLabs(fixture, visit, [fixture.labTest.id]);
      const invoice = await bill(fixture, visit);
      expect(invoice.total).toBe("1800.00");

      await cancelLabOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labOrderId: order.labOrderId,
        },
        { database: ctx.db },
      );

      const rows = await ctx.db
        .select()
        .from(charges)
        .where(
          and(
            eq(charges.facilityId, fixture.facility.id),
            eq(charges.encounterId, visit.encounterId),
            eq(charges.sourceType, "lab"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].voidedAt).not.toBeNull();
      expect(rows[0].voidedBy).toBe("vitest");

      const updated = await invoiceRow(fixture.facility.id, invoice.invoiceId);
      expect(updated.total).toBe("1000.00");
      expect(updated.status).toBe("open");
    });
  });

  it("voids a medicine line when the dispense is reversed", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const prescription = await prescribeDrug(fixture, visit, 4);
      await dispenseDrug(fixture, prescription.prescriptionId);
      const invoice = await bill(fixture, visit);
      expect(invoice.total).toBe("1008.00");

      await reverseDispense(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          prescriptionId: prescription.prescriptionId,
          note: "Patient refused the tablets",
        },
        { database: ctx.db },
      );

      const drugRows = await ctx.db
        .select()
        .from(charges)
        .where(
          and(
            eq(charges.facilityId, fixture.facility.id),
            eq(charges.encounterId, visit.encounterId),
            eq(charges.sourceType, "drug"),
          ),
        );
      expect(drugRows).toHaveLength(1);
      expect(drugRows[0].voidedAt).not.toBeNull();

      const updated = await invoiceRow(fixture.facility.id, invoice.invoiceId);
      expect(updated.total).toBe("1000.00");
      expect(updated.status).toBe("open");
    });
  });

  it("locks the lines of a paid invoice when the clinical record changes", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const order = await orderLabs(fixture, visit, [fixture.labTest.id]);
      const invoice = await bill(fixture, visit);
      await pay(fixture, invoice.invoiceId, [{ method: "cash", amount: 1800 }]);

      await cancelLabOrder(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          encounterId: visit.encounterId,
          labOrderId: order.labOrderId,
        },
        { database: ctx.db },
      );

      const labRows = await ctx.db
        .select()
        .from(charges)
        .where(
          and(
            eq(charges.facilityId, fixture.facility.id),
            eq(charges.encounterId, visit.encounterId),
            eq(charges.sourceType, "lab"),
          ),
        );
      expect(labRows).toHaveLength(1);
      expect(labRows[0].voidedAt).toBeNull();

      const updated = await invoiceRow(fixture.facility.id, invoice.invoiceId);
      expect(updated.total).toBe("1800.00");
      expect(updated.status).toBe("paid");
    });
  });

  it("raises the consultation charge even before the doctor starts the consultation", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);

      // No startConsultation call: billing a triaged visit still carries the
      // consultation fee, because the visit is what is being charged.
      const invoice = await bill(fixture, visit);
      expect(invoice.chargeCount).toBe(1);
      expect(invoice.total).toBe("1000.00");

      const rows = await activeCharges(fixture.facility.id, visit.encounterId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceType: "consultation",
        sourceId: visit.encounterId,
        serviceId: fixture.consultationService!.id,
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/* Payer price lists                                                   */
/* ------------------------------------------------------------------ */

describe("payer price lists", () => {
  it("prices a visit from the encounter's payer list", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture, { payerType: "sha" });
      await consult(fixture, visit);
      await orderLabs(fixture, visit, [fixture.labTest.id]);

      const rows = await activeCharges(fixture.facility.id, visit.encounterId);
      const consultation = rows.find((row) => row.sourceType === "consultation")!;
      const lab = rows.find((row) => row.sourceType === "lab")!;
      expect(consultation.unitPrice).toBe("1100.00");
      expect(lab.unitPrice).toBe("900.00");
      expect((await bill(fixture, visit)).total).toBe("2000.00");
    });
  });

  it("falls back to the cash list when the payer has no list of its own", async () => {
    await withCashierFacility(
      async (fixture) => {
        const visit = await createVisit(fixture, { payerType: "sha" });
        await consult(fixture, visit);

        const rows = await activeCharges(fixture.facility.id, visit.encounterId);
        expect(rows[0].unitPrice).toBe("1000.00");
      },
      { priceLists: ["cash"] },
    );
  });

  it("falls back to the service default when the list has no row for it", async () => {
    await withCashierFacility(
      async (fixture) => {
        const visit = await createVisit(fixture);
        await consult(fixture, visit);

        const rows = await activeCharges(fixture.facility.id, visit.encounterId);
        expect(rows[0].serviceId).toBe(fixture.consultationService!.id);
        expect(rows[0].unitPrice).toBe("1000.00");
      },
      { skipConsultationPrice: true },
    );
  });

  it("skips a medicine line the payer list has not priced", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture, { payerType: "insurance" });
      await consult(fixture, visit);
      const prescription = await prescribeDrug(fixture, visit, 6);
      await dispenseDrug(fixture, prescription.prescriptionId);

      const rows = await activeCharges(fixture.facility.id, visit.encounterId);
      expect(rows.map((row) => row.sourceType)).toEqual(["consultation"]);
      expect(rows[0].unitPrice).toBe("1250.00");
      expect((await bill(fixture, visit)).total).toBe("1250.00");
    });
  });

  it("prefers a facility service over a shared row with the same code", async () => {
    await withCashierFacility(
      async (fixture) => {
        const visit = await createVisit(fixture);
        await consult(fixture, visit);

        const rows = await activeCharges(fixture.facility.id, visit.encounterId);
        expect(rows[0].serviceId).toBe(fixture.consultationService!.id);
        expect(rows[0].unitPrice).toBe("1000.00");
      },
      { sharedConsultationPrice: "9999.00" },
    );
  });

  it("lists each payer list with its price count", async () => {
    await withCashierFacility(async (fixture) => {
      const lists = await listPriceLists(ctx.db, fixture.facility.id);
      expect(lists.map((list) => list.payerType)).toEqual(["cash", "sha", "insurance"]);
      expect(lists.map((list) => list.priceCount)).toEqual([3, 3, 2]);
      expect(lists.every((list) => list.active)).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

describe("invoices", () => {
  it("numbers invoices sequentially per facility and reuses the open invoice", async () => {
    await withCashierFacility(async (fixture) => {
      const firstVisit = await createVisit(fixture);
      await consult(fixture, firstVisit);
      const first = await bill(fixture, firstVisit);
      expect(first.invoiceNo).toBe(formatNumber("FAH", "invoice", 1));

      const secondVisit = await createVisit(fixture);
      await consult(fixture, secondVisit);
      const second = await bill(fixture, secondVisit);
      expect(second.invoiceNo).toBe(formatNumber("FAH", "invoice", 2));

      await orderLabs(fixture, firstVisit, [fixture.labTest.id]);
      const refreshed = await bill(fixture, firstVisit);
      expect(refreshed.invoiceId).toBe(first.invoiceId);
      expect(refreshed.invoiceNo).toBe(first.invoiceNo);
      expect(refreshed.total).toBe("1800.00");
      expect(refreshed.chargeCount).toBe(1);

      const rows = await ctx.db
        .select()
        .from(invoices)
        .where(eq(invoices.facilityId, fixture.facility.id));
      expect(rows).toHaveLength(2);
    });
  });

  it("replays an idempotent invoice without allocating a second number", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const key = newIdempotencyKey();
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: key,
        actor: ACTOR,
        encounterId: visit.encounterId,
      };

      const first = await openInvoice(input, { database: ctx.db });
      const replay = await openInvoice(input, { database: ctx.db });
      expect(replay).toEqual(first);

      const rows = await ctx.db
        .select()
        .from(invoices)
        .where(eq(invoices.facilityId, fixture.facility.id));
      expect(rows).toHaveLength(1);
    });
  });

  it("shows the bill with its lines, invoice and payments", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 600 },
        { method: "mpesa", amount: 400 },
      ]);

      const view = await getEncounterBill(ctx.db, fixture.facility.id, visit.encounterId);
      expect(view).not.toBeNull();
      expect(view!.invoice).toMatchObject({
        id: invoice.invoiceId,
        invoiceNo: invoice.invoiceNo,
        status: "paid",
        total: "1000.00",
        paid: "1000.00",
        outstanding: "0.00",
      });
      expect(view!.charges).toHaveLength(1);
      expect(view!.charges[0]).toMatchObject({
        sourceType: "consultation",
        amount: "1000.00",
        voidedAt: null,
      });
      expect(view!.payments.map((row) => row.receiptNo)).toEqual([
        payment.payments[0].receiptNo,
        payment.payments[1].receiptNo,
      ]);
      expect(view!.outstanding).toBe("0.00");

      const byInvoice = await getInvoiceDetail(ctx.db, fixture.facility.id, invoice.invoiceId);
      expect(byInvoice).toEqual(view);
    });
  });

  it("voids an unpaid invoice and refuses to void one that still holds payments", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 400 },
      ]);

      await expect(
        voidInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            invoiceId: invoice.invoiceId,
            reason: "Duplicate visit",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/Reverse the payments before voiding/);

      await reversePayment(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          paymentId: payment.payments[0].paymentId,
          reason: "Wrong patient",
        },
        { database: ctx.db },
      );

      const voided = await voidInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: invoice.invoiceId,
          reason: "Duplicate visit",
        },
        { database: ctx.db },
      );
      expect(voided).toEqual({
        invoiceId: invoice.invoiceId,
        status: "void",
        voidedCharges: 1,
      });

      const row = await invoiceRow(fixture.facility.id, invoice.invoiceId);
      expect(row.status).toBe("void");
      expect(row.voidedBy).toBe("vitest");
      expect(row.notes).toBe("Duplicate visit");

      await expect(
        voidInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            invoiceId: invoice.invoiceId,
            reason: "Again",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already void/);
    });
  });

  it("refuses to raise a second active invoice for the same visit", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const first = await bill(fixture, visit);
      const second = await bill(fixture, visit);
      expect(second.invoiceId).toBe(first.invoiceId);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Payments and receipts                                               */
/* ------------------------------------------------------------------ */

describe("payments and receipts", () => {
  it("requires an open cashier session before taking money", async () => {
    await withCashierFacility(async (fixture) => {
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);

      await expect(
        pay(fixture, invoice.invoiceId, [{ method: "cash", amount: 1000 }]),
      ).rejects.toThrow(/Open a cashier session/);
    });
  });

  it("records a split tender as one receipt per method, numbered in order", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);

      const result = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 600 },
        { method: "mpesa", amount: 400, reference: "QK7H2XYZ" },
      ]);

      expect(result.status).toBe("paid");
      expect(result.total).toBe("1000.00");
      expect(result.paid).toBe("1000.00");
      expect(result.outstanding).toBe("0.00");
      expect(result.payments).toHaveLength(2);
      expect(result.payments[0]).toMatchObject({
        method: "cash",
        amount: "600.00",
        receiptNo: formatNumber(fixture.facility.code, "receipt", 1),
      });
      expect(result.payments[1]).toMatchObject({
        method: "mpesa",
        amount: "400.00",
        reference: "QK7H2XYZ",
        receiptNo: formatNumber(fixture.facility.code, "receipt", 2),
      });

      const rows = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.facilityId, fixture.facility.id))
        .orderBy(asc(payments.createdAt));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.receiptNo)).toEqual([
        formatNumber(fixture.facility.code, "receipt", 1),
        formatNumber(fixture.facility.code, "receipt", 2),
      ]);
    });
  });

  it("accepts a partial payment and settles the balance later", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);

      const first = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 400 },
      ]);
      expect(first.status).toBe("partial");
      expect(first.paid).toBe("400.00");
      expect(first.outstanding).toBe("600.00");
      expect((await invoiceRow(fixture.facility.id, invoice.invoiceId)).status).toBe("partial");

      const second = await pay(fixture, invoice.invoiceId, [
        { method: "card", amount: 600 },
      ]);
      expect(second.status).toBe("paid");
      expect(second.paid).toBe("1000.00");
      expect(second.outstanding).toBe("0.00");
      expect((await invoiceRow(fixture.facility.id, invoice.invoiceId)).status).toBe("paid");
    });
  });

  it("rejects a tender above the outstanding balance", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);

      await expect(
        pay(fixture, invoice.invoiceId, [{ method: "cash", amount: 1200 }]),
      ).rejects.toThrow(/exceed the outstanding balance/);

      const rows = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.facilityId, fixture.facility.id));
      expect(rows).toHaveLength(0);
      expect((await invoiceRow(fixture.facility.id, invoice.invoiceId)).paid).toBe("0.00");
    });
  });

  it("replays an idempotent payment without issuing a second receipt", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const key = newIdempotencyKey();
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: key,
        actor: ACTOR,
        invoiceId: invoice.invoiceId,
        tenders: [{ method: "cash" as const, amount: 1000 }],
      };

      const first = await takePayment(input, { database: ctx.db });
      const replay = await takePayment(input, { database: ctx.db });
      expect(replay).toEqual(first);

      const rows = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.facilityId, fixture.facility.id));
      expect(rows).toHaveLength(1);
    });
  });

  it("never lets concurrent payments collect more than the invoice total", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);

      const attempts = Array.from({ length: 8 }, () =>
        takePayment(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            invoiceId: invoice.invoiceId,
            tenders: [{ method: "cash", amount: 400 }],
          },
          { database: ctx.db },
        )
          .then(() => "ok" as const)
          .catch(() => "rejected" as const),
      );
      const outcomes = await Promise.all(attempts);
      expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(2);
      expect(outcomes.filter((outcome) => outcome === "rejected")).toHaveLength(6);

      const row = await invoiceRow(fixture.facility.id, invoice.invoiceId);
      expect(row.paid).toBe("800.00");
      expect(row.status).toBe("partial");

      const receipts = await ctx.db
        .select({ receiptNo: payments.receiptNo })
        .from(payments)
        .where(eq(payments.facilityId, fixture.facility.id));
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map((receipt) => receipt.receiptNo)).size).toBe(2);
    });
  });

  it("reverses a payment as a negative row and leaves the original untouched", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 1000 },
      ]);
      const original = payment.payments[0];

      const reversal = await reversePayment(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          paymentId: original.paymentId,
          reason: "Patient cancelled the consultation",
        },
        { database: ctx.db },
      );
      expect(reversal).toMatchObject({
        invoiceId: invoice.invoiceId,
        amount: "-1000.00",
        total: "1000.00",
        paid: "0.00",
        outstanding: "1000.00",
        status: "open",
        receiptNo: formatNumber(fixture.facility.code, "receipt", 2),
      });

      const rows = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.facilityId, fixture.facility.id))
        .orderBy(asc(payments.createdAt));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: original.paymentId,
        receiptNo: original.receiptNo,
        amount: "1000.00",
        reversedPaymentId: null,
      });
      expect(rows[1]).toMatchObject({
        id: reversal.reversalPaymentId,
        amount: "-1000.00",
        method: "cash",
        reversedPaymentId: original.paymentId,
        note: "Patient cancelled the consultation",
      });
      expect((await invoiceRow(fixture.facility.id, invoice.invoiceId)).status).toBe("open");
    });
  });

  it("refuses to reverse a payment twice or to reverse a reversal", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 1000 },
      ]);
      const reversal = await reversePayment(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          paymentId: payment.payments[0].paymentId,
          reason: "Duplicate charge",
        },
        { database: ctx.db },
      );

      await expect(
        reversePayment(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            paymentId: payment.payments[0].paymentId,
            reason: "Again",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already been reversed/);

      await expect(
        reversePayment(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            paymentId: reversal.reversalPaymentId,
            reason: "Reverse the reversal",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/A reversal cannot be reversed/);
    });
  });

  it("keeps the payment ledger append-only at the database level", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 1000 },
      ]);

      async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
        try {
          await promise;
        } catch (error) {
          const cause = (error as { cause?: unknown }).cause;
          const detail = cause instanceof Error ? cause.message : String(cause ?? "");
          return `${(error as Error).message} ${detail}`;
        }
        throw new Error("Expected the payment write to be rejected");
      }

      expect(
        await rejectionMessage(
          ctx.db
            .update(payments)
            .set({ amount: "1.00" })
            .where(
              and(
                eq(payments.facilityId, fixture.facility.id),
                eq(payments.id, payment.payments[0].paymentId),
              ),
            ),
        ),
      ).toMatch(/append-only/);

      expect(
        await rejectionMessage(
          ctx.db.delete(payments).where(eq(payments.facilityId, fixture.facility.id)),
        ),
      ).toMatch(/append-only/);

      const rows = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.facilityId, fixture.facility.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].amount).toBe("1000.00");
    });
  });

  it("prints a stable 80 mm receipt that matches a reprint", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 600 },
        { method: "mpesa", amount: 400, reference: "QK7H2XYZ" },
      ]);

      const receipt = await getReceipt(
        ctx.db,
        fixture.facility.id,
        payment.payments[1].paymentId,
      );
      expect(receipt).not.toBeNull();
      expect(receipt!.receiptNo).toBe(payment.payments[1].receiptNo);
      expect(receipt!.invoiceNo).toBe(invoice.invoiceNo);
      expect(receipt!.patientName).toBe("Amina Otieno");
      expect(receipt!.lines).toHaveLength(1);
      expect(receipt!.payment).toEqual({
        method: "mpesa",
        amount: "400.00",
        reference: "QK7H2XYZ",
      });
      expect(receipt!.payments).toHaveLength(2);
      expect(receipt!.isReversal).toBe(false);

      const text = renderReceiptText(receipt!);
      expect(text).toContain(receipt!.receiptNo);
      expect(text).toContain("M-Pesa");
      expect(text).toContain("Total");
      for (const line of text.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(RECEIPT_WIDTH_CHARS);
      }

      const reprint = await getReceipt(
        ctx.db,
        fixture.facility.id,
        payment.payments[1].paymentId,
      );
      expect(reprint).toEqual(receipt);
      expect(renderReceiptText(reprint!)).toBe(text);
    });
  });

  it("marks a reversal receipt and shows the negative amount", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 1000 },
      ]);
      const reversal = await reversePayment(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          paymentId: payment.payments[0].paymentId,
          reason: "Wrong patient",
        },
        { database: ctx.db },
      );

      const receipt = await getReceipt(
        ctx.db,
        fixture.facility.id,
        reversal.reversalPaymentId,
      );
      expect(receipt).not.toBeNull();
      expect(receipt!.isReversal).toBe(true);
      expect(receipt!.payment.amount).toBe("-1000.00");
      expect(receipt!.receiptNo).toBe(reversal.receiptNo);
      expect(receipt!.payment.reference).toBe(payment.payments[0].receiptNo);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Cashier sessions and end of day                                     */
/* ------------------------------------------------------------------ */

describe("cashier sessions", () => {
  it("opens one session per cashier and returns the existing drawer", async () => {
    await withCashierFacility(async (fixture) => {
      const first = await openSession(fixture, 5000);
      expect(first.alreadyOpen).toBe(false);
      expect(first.openingFloat).toBe("5000.00");

      const second = await openSession(fixture, 9000);
      expect(second.alreadyOpen).toBe(true);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.openingFloat).toBe("5000.00");

      const open = await getOpenCashierSession(ctx.db, fixture.facility.id, "vitest");
      expect(open).not.toBeNull();
      expect(open!.sessionId).toBe(first.sessionId);
      expect(open!.openingFloat).toBe("5000.00");
      expect(open!.isOpen).toBe(true);
    });
  });

  it("expects opening float plus net cash and reports the drawer variance", async () => {
    await withCashierFacility(async (fixture) => {
      const session = await openSession(fixture, 5000);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 600 },
        { method: "mpesa", amount: 400 },
      ]);

      const closed = await closeCashierSession(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          sessionId: session.sessionId,
          countedCash: 5600,
          note: "Drawer balanced",
        },
        { database: ctx.db },
      );
      expect(closed.openingFloat).toBe("5000.00");
      expect(closed.expectedCash).toBe("5600.00");
      expect(closed.countedCash).toBe("5600.00");
      expect(closed.variance).toBe("0.00");
      expect(closed.methods).toEqual([
        { method: "cash", amount: "600.00", count: 1 },
        { method: "mpesa", amount: "400.00", count: 1 },
        { method: "card", amount: "0.00", count: 0 },
        { method: "insurance", amount: "0.00", count: 0 },
      ]);

      expect(await getOpenCashierSession(ctx.db, fixture.facility.id, "vitest")).toBeNull();
      const sessions = await listCashierSessions(ctx.db, fixture.facility.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: session.sessionId,
        isOpen: false,
        note: "Drawer balanced",
        variance: "0.00",
        totalCollected: "1000.00",
        paymentCount: 2,
      });
    });
  });

  it("reports a short or over drawer as a signed variance", async () => {
    await withCashierFacility(async (fixture) => {
      const session = await openSession(fixture, 1000);

      const short = await closeCashierSession(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          sessionId: session.sessionId,
          countedCash: 950,
        },
        { database: ctx.db },
      );
      expect(short.expectedCash).toBe("1000.00");
      expect(short.variance).toBe("-50.00");
    });
  });

  it("closes a session once only", async () => {
    await withCashierFacility(async (fixture) => {
      const session = await openSession(fixture, 0);
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: ACTOR,
        sessionId: session.sessionId,
        countedCash: 0,
      };
      await closeCashierSession(input, { database: ctx.db });

      await expect(
        closeCashierSession(
          { ...input, idempotencyKey: newIdempotencyKey() },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/already closed/);
    });
  });

  it("builds an end-of-day report with collections, reversals and cash expected", async () => {
    await withCashierFacility(async (fixture) => {
      const session = await openSession(fixture, 2000);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 1000 },
      ]);
      await reversePayment(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          paymentId: payment.payments[0].paymentId,
          reason: "Patient changed their mind",
        },
        { database: ctx.db },
      );

      const report = await getEndOfDayReport(ctx.db, fixture.facility.id, session.sessionId);
      expect(report).not.toBeNull();
      expect(report!.totalCollected).toBe("1000.00");
      expect(report!.totalReversed).toBe("-1000.00");
      expect(report!.netCollected).toBe("0.00");
      expect(report!.cashExpected).toBe("2000.00");
      expect(report!.payments).toHaveLength(2);
      expect(report!.payments.map((row) => row.isReversal)).toEqual([false, true]);
      expect(report!.invoiceCount).toBe(1);
      expect(report!.paidInvoiceCount).toBe(0);
      expect(report!.invoiceTotal).toBe("1000.00");
      expect(report!.invoicePaid).toBe("0.00");
      expect(report!.totals).toEqual([
        { method: "cash", amount: "0.00", count: 2 },
        { method: "mpesa", amount: "0.00", count: 0 },
        { method: "card", amount: "0.00", count: 0 },
        { method: "insurance", amount: "0.00", count: 0 },
      ]);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Cashier queue and facility isolation                                */
/* ------------------------------------------------------------------ */

describe("cashier queue and isolation", () => {
  it("lists unbilled visits, keeps invoiced ones until settled, then drops them", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      const other = await createVisit(fixture);
      await consult(fixture, visit);

      const unbilled = await getCashierQueue(ctx.db, fixture.facility.id);
      const unbilledRow = unbilled.find((row) => row.encounterId === visit.encounterId);
      expect(unbilledRow).toBeDefined();
      expect(unbilledRow).toMatchObject({
        mrn: visit.mrn,
        patientName: "Amina Otieno",
        invoiceId: null,
        unbilledCount: 1,
        unbilledTotal: "1000.00",
        total: "1000.00",
        paid: "0.00",
        outstanding: "1000.00",
      });
      expect(unbilled.some((row) => row.encounterId === other.encounterId)).toBe(false);

      const invoice = await bill(fixture, visit);
      const invoiced = await getCashierQueue(ctx.db, fixture.facility.id);
      expect(invoiced.find((row) => row.encounterId === visit.encounterId)).toMatchObject({
        invoiceId: invoice.invoiceId,
        invoiceStatus: "open",
        unbilledCount: 0,
        total: "1000.00",
      });

      await pay(fixture, invoice.invoiceId, [{ method: "cash", amount: 1000 }]);
      const settled = await getCashierQueue(ctx.db, fixture.facility.id);
      expect(settled.some((row) => row.encounterId === visit.encounterId)).toBe(false);

      const searched = await getCashierQueue(ctx.db, fixture.facility.id, visit.mrn);
      expect(searched).toHaveLength(0);
    });
  });

  it("searches the queue by patient name and MRN", async () => {
    await withCashierFacility(async (fixture) => {
      const first = await createVisit(fixture, {
        overrides: { firstName: "Zawadi", lastName: "Mwangi" },
      });
      const second = await createVisit(fixture, {
        overrides: { firstName: "Baraka", lastName: "Ochieng" },
      });
      await consult(fixture, first);
      await consult(fixture, second);

      const byName = await getCashierQueue(ctx.db, fixture.facility.id, "Zawadi");
      expect(byName.map((row) => row.encounterId)).toEqual([first.encounterId]);

      const byMrn = await getCashierQueue(ctx.db, fixture.facility.id, second.mrn);
      expect(byMrn.map((row) => row.encounterId)).toEqual([second.encounterId]);
    });
  });

  it("does not expose another facility's bills, receipts or invoices", async () => {
    await withCashierFacility(async (fixture) => {
      await openSession(fixture);
      const visit = await createVisit(fixture);
      await consult(fixture, visit);
      const invoice = await bill(fixture, visit);
      const payment = await pay(fixture, invoice.invoiceId, [
        { method: "cash", amount: 1000 },
      ]);

      const otherFacility = await insertTestFacility(ctx.db);
      try {
        expect(await getEncounterBill(ctx.db, otherFacility.id, visit.encounterId)).toBeNull();
        expect(await getInvoiceDetail(ctx.db, otherFacility.id, invoice.invoiceId)).toBeNull();
        expect(
          await getReceipt(ctx.db, otherFacility.id, payment.payments[0].paymentId),
        ).toBeNull();
        expect(
          await getEndOfDayReport(ctx.db, otherFacility.id, payment.payments[0].paymentId),
        ).toBeNull();

        await expect(
          voidInvoice(
            {
              facilityId: otherFacility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              invoiceId: invoice.invoiceId,
              reason: "Cross-facility",
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/not found in this facility/);

        await expect(
          reversePayment(
            {
              facilityId: otherFacility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              paymentId: payment.payments[0].paymentId,
              reason: "Cross-facility",
            },
            { database: ctx.db },
          ),
        ).rejects.toThrow(/not found in this facility/);
      } finally {
        await cleanupTestFacility(ctx.db, otherFacility.id);
      }
    });
  });
});
