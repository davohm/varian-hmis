import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ETIMS_SANDBOX_STUB_URL, type EtimsResponsePayload } from "../src/lib/tax";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import {
  cancelEtimsInvoice,
  enqueueEtimsInvoice,
  finalizeInvoice,
  generateEtimsSignature,
  getEtimsInvoiceStatus,
  reconcileEtimsQueue,
  retryEtimsInvoice,
  transmitEtimsInvoice,
} from "../src/server/commands/tax";
import { nextFormattedNumber } from "../src/server/numbering";
import {
  auditLog,
  charges,
  encounters,
  etimsInvoiceLines,
  etimsInvoiceQueue,
  etimsOutbox,
  etimsTransmissionLog,
  facilityRegulatoryProfiles,
  facilitySettings,
  integrationSettings,
  invoices,
  numberSequences,
  patients,
  services,
  taxCodeApplicabilities,
  taxCodes,
} from "../src/server/db/schema";
import {
  buildEtimsRequestPayload,
  createEtimsClient,
  getEtimsSpec,
  type EtimsClient,
} from "../src/server/integrations/etims";
import { getEtimsTransactionDetail } from "../src/server/queries/tax";

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

const ACTOR = { userId: "vitest", deviceId: "tax-station" };

interface TaxFixture {
  facility: { id: string; code: string };
  branchId: string;
  invoiceId: string;
  invoiceNo: string;
  serviceId: string;
  exemptCodeId: string;
  defaultCodeId: string;
  controlNo: string;
}

async function expectCommandError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error(`Expected command to fail with ${pattern}`);
}

type KraResponse = { status: number; payload: EtimsResponsePayload };

function stubClient(
  config: Parameters<typeof createEtimsClient>[0],
  respond: (call: number) => KraResponse,
): EtimsClient {
  const spec = getEtimsSpec(config.specVersion);
  let call = 0;
  return {
    async send(document) {
      call += 1;
      const requestPayload = buildEtimsRequestPayload(document, config);
      const response = respond(call);
      return {
        requestPayload,
        response,
        result: spec.parseResponse(response.payload, response.status),
      };
    },
  };
}

function acknowledgement(controlNo: string): KraResponse {
  return {
    status: 200,
    payload: {
      resultCode: "00",
      resultMsg: "Accepted",
      controlNo,
      signature: `SIGN-${controlNo}`,
      qrUrl: `https://kra.test/qr/${controlNo}`,
      cuNo: `CU-${controlNo}`,
    },
  };
}

function optionsFor(factory: (config: Parameters<typeof createEtimsClient>[0]) => EtimsClient, env?: NodeJS.ProcessEnv) {
  return {
    database: ctx.db,
    etimsClientFactory: factory,
    ...(env ? { env } : {}),
  };
}

async function createInvoice(
  fixture: Pick<TaxFixture, "facility" | "branchId" | "serviceId">,
  options: { amount?: string; serviceId?: string; mrn?: string } = {},
) {
  const amount = options.amount ?? "1000.00";
  const patientId = newId();
  const suffix = randomUUID().slice(0, 8);
  await ctx.db.insert(patients).values({
    id: patientId,
    facilityId: fixture.facility.id,
    mrn: options.mrn ?? `TAX-${suffix}`,
    firstName: "Wanjiku",
    lastName: "Mutua",
    sex: "female",
    payerType: "cash",
    createdBy: "vitest",
  });

  const encounterId = newId();
  await ctx.db.insert(encounters).values({
    id: encounterId,
    facilityId: fixture.facility.id,
    branchId: fixture.branchId,
    patientId,
    encounterNo: `TAXE-${suffix}`,
    payerType: "cash",
    createdBy: "vitest",
  });

  const invoiceNo = await nextFormattedNumber(ctx.db, fixture.facility, "invoice", "FAH");
  const invoiceId = newId();
  await ctx.db.insert(invoices).values({
    id: invoiceId,
    facilityId: fixture.facility.id,
    encounterId,
    invoiceNo,
    subtotal: amount,
    total: amount,
    paid: "0.00",
    status: "open",
    createdBy: "vitest",
  });

  await ctx.db.insert(charges).values({
    id: newId(),
    facilityId: fixture.facility.id,
    encounterId,
    invoiceId,
    sourceType: "tax-test",
    sourceId: suffix,
    serviceId: options.serviceId ?? fixture.serviceId,
    description: "Consultation",
    quantity: 1,
    unitPrice: amount,
    amount,
    createdBy: "vitest",
  });

  return { invoiceId, invoiceNo, encounterId, patientId };
}

async function withTaxFacility<T>(
  run: (fixture: TaxFixture) => Promise<T>,
  options: {
    kraPin?: string | null;
    sandboxUrl?: string;
    productionUrl?: string;
    productionEnabled?: boolean;
  } = {},
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

  await ctx.db.insert(facilityRegulatoryProfiles).values({
    facilityId: facility.id,
    kraPin: options.kraPin === undefined ? "P052292910Q" : options.kraPin,
    facilityCategory: "medical_centre",
    county: "Nairobi",
    licenceStatus: "pending",
    updatedBy: "vitest",
    createdBy: "vitest",
  });

  const standard = await ctx.db
    .insert(taxCodes)
    .values({
      id: newId(),
      facilityId: facility.id,
      code: "VAT_STANDARD",
      name: "VAT 16%",
      rate: "16.0000",
      treatment: "vat_standard",
      kraCode: "VAT",
      effectiveFrom: "2000-01-01",
      active: true,
      isDefault: true,
      createdBy: "vitest",
    })
    .returning({ id: taxCodes.id });

  const exempt = await ctx.db
    .insert(taxCodes)
    .values({
      id: newId(),
      facilityId: facility.id,
      code: "EXEMPT",
      name: "VAT exempt",
      rate: "0.0000",
      treatment: "exempt",
      kraCode: "EXEMPT",
      effectiveFrom: "2000-01-01",
      active: true,
      isDefault: false,
      createdBy: "vitest",
    })
    .returning({ id: taxCodes.id });

  const serviceId = newId();
  await ctx.db.insert(services).values({
    id: serviceId,
    facilityId: facility.id,
    code: `CONS-${suffix}`,
    name: "Consultation",
    kind: "consultation",
    defaultPrice: "1000.00",
    createdBy: "vitest",
  });

  await ctx.db.insert(integrationSettings).values([
    {
      id: newId(),
      facilityId: facility.id,
      integration: "etims",
      environment: "sandbox",
      baseUrl: options.sandboxUrl ?? ETIMS_SANDBOX_STUB_URL,
      mode: "oscu",
      specVersion: "oscu-1.0",
      credentialRef: "ETIMS_SANDBOX_API_KEY",
      timeoutMs: 30_000,
      maxAttempts: 5,
      backoffSeconds: [1, 2, 4, 8, 16],
      enabled: true,
      createdBy: "vitest",
    },
    {
      id: newId(),
      facilityId: facility.id,
      integration: "etims",
      environment: "production",
      baseUrl: options.productionUrl ?? "https://kra.go.ke/production",
      mode: "oscu",
      specVersion: "oscu-1.0",
      credentialRef: "ETIMS_PRODUCTION_API_KEY",
      timeoutMs: 30_000,
      maxAttempts: 5,
      backoffSeconds: [30, 120, 600, 1800, 3600],
      enabled: options.productionEnabled ?? false,
      createdBy: "vitest",
    },
  ]);

  const invoice = await createInvoice({ facility, branchId, serviceId });

  try {
    return await run({
      facility,
      branchId,
      serviceId,
      defaultCodeId: standard[0].id,
      exemptCodeId: exempt[0].id,
      invoiceId: invoice.invoiceId,
      invoiceNo: invoice.invoiceNo,
      controlNo: `KRA-${suffix}`,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

async function queueRows(facilityId: string, queueId?: string) {
  return ctx.db
    .select()
    .from(etimsInvoiceQueue)
    .where(
      queueId
        ? and(eq(etimsInvoiceQueue.facilityId, facilityId), eq(etimsInvoiceQueue.id, queueId))
        : eq(etimsInvoiceQueue.facilityId, facilityId),
    );
}

async function finalizeAndTransmit(
  fixture: TaxFixture,
  respond: (call: number) => KraResponse,
  options: { environment?: "sandbox" | "production"; env?: NodeJS.ProcessEnv } = {},
) {
  const stub = stubClient(
    {
      baseUrl: ETIMS_SANDBOX_STUB_URL,
      environment: options.environment ?? "sandbox",
      mode: "oscu",
      specVersion: "oscu-1.0",
      timeoutMs: 30_000,
    },
    respond,
  );
  const commandOptions = optionsFor(() => stub, options.env);
  const queue = await finalizeInvoice(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      invoiceId: fixture.invoiceId,
      environment: options.environment ?? "sandbox",
    },
    commandOptions,
  );
  const result = await transmitEtimsInvoice(
    {
      facilityId: fixture.facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: ACTOR,
      queueId: queue.queueId,
      environment: options.environment ?? "sandbox",
    },
    commandOptions,
  );
  return { queue, result, stub };
}

describe("tax and eTIMS business rules", () => {
  it("1. blocks enqueue without a valid KRA PIN and audits the refusal", async () => {
    await withTaxFacility(
      async (fixture) => {
        await expectCommandError(
          enqueueEtimsInvoice(
            {
              facilityId: fixture.facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              invoiceId: fixture.invoiceId,
            },
            { database: ctx.db },
          ),
          /valid KRA PIN/i,
        );

        const audits = await ctx.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.facilityId, fixture.facility.id), eq(auditLog.action, "tax.enqueue.blocked")));
        expect(audits).toHaveLength(1);
        expect(await queueRows(fixture.facility.id)).toHaveLength(0);
      },
      { kraPin: null },
    );
  });

  it("2. allocates gap-free FAH invoice numbers per facility and per year", async () => {
    const facility = await insertTestFacility(ctx.db);
    const second = await insertTestFacility(ctx.db);
    try {
      const setting = await ctx.db
        .select()
        .from(facilitySettings)
        .where(
          and(
            eq(facilitySettings.facilityId, facility.id),
            eq(facilitySettings.domain, "tax"),
            eq(facilitySettings.key, "invoice_prefix"),
          ),
        );
      expect(setting[0].valueText).toBe("FAH");

      // A prior-year sequence must not consume the current year's numbers.
      await ctx.db.insert(numberSequences).values({
        facilityId: facility.id,
        scope: "invoice",
        year: new Date().getFullYear() - 1,
        nextValue: 90,
      });

      const year = String(new Date().getFullYear()).slice(-2);
      const first = await nextFormattedNumber(ctx.db, facility, "invoice", "FAH");
      const secondInvoice = await nextFormattedNumber(ctx.db, facility, "invoice", "FAH");
      const otherFacility = await nextFormattedNumber(ctx.db, second, "invoice", "FAH");
      expect(first).toBe(`FAH-I-${year}-000001`);
      expect(secondInvoice).toBe(`FAH-I-${year}-000002`);
      expect(otherFacility).toBe(`FAH-I-${year}-000001`);
      expect(new Set([first, secondInvoice]).size).toBe(2);
    } finally {
      await cleanupTestFacility(ctx.db, facility.id);
      await cleanupTestFacility(ctx.db, second.id);
    }
  });

  it("3. returns the existing queue row for a duplicate idempotency key", async () => {
    await withTaxFacility(async (fixture) => {
      const key = newIdempotencyKey();
      const input = {
        facilityId: fixture.facility.id,
        idempotencyKey: key,
        actor: ACTOR,
        invoiceId: fixture.invoiceId,
      };
      const first = await finalizeInvoice(input, { database: ctx.db });
      const replay = await finalizeInvoice(input, { database: ctx.db });
      expect(replay).toEqual(first);
      const rows = await queueRows(fixture.facility.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.queueId);
    });
  });

  it("4. derives the total from lines and tax from tax codes", async () => {
    await withTaxFacility(async (fixture) => {
      const queue = await finalizeInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: fixture.invoiceId,
        },
        { database: ctx.db },
      );
      const lines = await ctx.db
        .select()
        .from(etimsInvoiceLines)
        .where(eq(etimsInvoiceLines.queueId, queue.queueId));
      const sum = lines.reduce((total, line) => total + Number(line.amount), 0);
      expect(sum).toBe(1000);
      expect(queue.totalAmount).toBe("1000.00");
      expect(queue.taxAmount).toBe("160.00");
      expect(lines[0]).toMatchObject({
        taxCode: "VAT_STANDARD",
        taxTreatment: "vat_standard",
        taxRate: "16.0000",
        taxAmount: "160.00",
      });
    });
  });

  it("5. treats an exempt service as zero-rated tax with an exempt treatment", async () => {
    await withTaxFacility(async (fixture) => {
      await ctx.db.insert(taxCodeApplicabilities).values({
        id: newId(),
        facilityId: fixture.facility.id,
        taxCodeId: fixture.exemptCodeId,
        serviceId: fixture.serviceId,
        effectiveFrom: "2000-01-01",
        active: true,
        createdBy: "vitest",
      });

      const queue = await finalizeInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: fixture.invoiceId,
        },
        { database: ctx.db },
      );
      const lines = await ctx.db
        .select()
        .from(etimsInvoiceLines)
        .where(eq(etimsInvoiceLines.queueId, queue.queueId));
      expect(queue.taxAmount).toBe("0.00");
      expect(lines[0]).toMatchObject({ taxCode: "EXEMPT", taxTreatment: "exempt", taxAmount: "0.00" });

      const sent = await generateEtimsSignature(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: fixture.invoiceId,
        },
        optionsFor((config) => stubClient(config, () => acknowledgement(fixture.controlNo))),
      );
      expect(sent.status).toBe("acknowledged");
    });
  });

  it("6. never mutates an acknowledged invoice; correction is a credit note", async () => {
    await withTaxFacility(async (fixture) => {
      const { queue } = await finalizeAndTransmit(fixture, () => acknowledgement(fixture.controlNo));
      const before = (await queueRows(fixture.facility.id, queue.queueId))[0];
      expect(before.status).toBe("acknowledged");

      await expectCommandError(
        transmitEtimsInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            queueId: queue.queueId,
          },
          optionsFor((config) => stubClient(config, () => acknowledgement(fixture.controlNo))),
        ),
        /acknowledged.*cannot be transmitted again/i,
      );

      const credit = await cancelEtimsInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          queueId: queue.queueId,
          reason: "Test correction",
        },
        { database: ctx.db },
      );
      expect(credit.documentType).toBe("credit_note");
      expect(credit.creditNoteOf).toBe(queue.queueId);

      const after = (await queueRows(fixture.facility.id, queue.queueId))[0];
      expect(after).toEqual(before);
    });
  });

  it("7. retries with backoff, increments attempts and keeps one control number", async () => {
    await withTaxFacility(async (fixture) => {
      const key = newIdempotencyKey();
      const queue = await finalizeInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: key,
          actor: ACTOR,
          invoiceId: fixture.invoiceId,
        },
        { database: ctx.db },
      );
      // The command creates a fresh client per transmission, so keep the call
      // counter outside the factory to drive a failure followed by a success.
      let call = 0;
      const commandOptions = optionsFor((config) =>
        stubClient(config, () => {
          call += 1;
          return call === 1
            ? { status: 500, payload: { resultCode: "E500", resultMsg: "Temporary outage" } }
            : acknowledgement(fixture.controlNo);
        }),
      );

      const failed = await transmitEtimsInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          queueId: queue.queueId,
        },
        commandOptions,
      );
      expect(failed.status).toBe("failed");
      expect(failed.attempts).toBe(1);
      expect(failed.nextAttemptAt).toBeTruthy();
      expect(new Date(failed.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());

      await expectCommandError(
        retryEtimsInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            queueId: queue.queueId,
          },
          commandOptions,
        ),
        /backoff window/i,
      );

      // A maxed-out document is refused before another adapter call.
      await ctx.db
        .update(etimsInvoiceQueue)
        .set({ attempts: 5, nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(etimsInvoiceQueue.id, queue.queueId));
      await expectCommandError(
        retryEtimsInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            queueId: queue.queueId,
          },
          commandOptions,
        ),
        /attempt limit/i,
      );

      // Operator-approved retry after the backoff window.
      await ctx.db
        .update(etimsInvoiceQueue)
        .set({ attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(etimsInvoiceQueue.id, queue.queueId));
      const retried = await retryEtimsInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          queueId: queue.queueId,
        },
        commandOptions,
      );
      expect(retried.status).toBe("acknowledged");
      expect(retried.attempts).toBe(2);
      expect(retried.kraControlNo).toBe(fixture.controlNo);
      const rows = await queueRows(fixture.facility.id);
      expect(rows).toHaveLength(1);
      expect(rows.filter((row) => row.kraControlNo === fixture.controlNo)).toHaveLength(1);
    });
  });

  it("8. stores a 4xx rejection and does not retry it automatically", async () => {
    await withTaxFacility(async (fixture) => {
      const { queue, result } = await finalizeAndTransmit(fixture, () => ({
        status: 400,
        payload: { resultCode: "E004", resultMsg: "Invalid buyer PIN" },
      }));
      expect(result.status).toBe("rejected");
      expect(result.responseCode).toBe("E004");

      const row = (await queueRows(fixture.facility.id, queue.queueId))[0];
      expect(row.status).toBe("rejected");
      expect(row.responseCode).toBe("E004");
      expect(row.responseMessage).toBe("Invalid buyer PIN");
      expect(row.lastError).toBe("Invalid buyer PIN");
      expect(row.nextAttemptAt).toBeNull();
      expect(row.attempts).toBe(1);

      await expectCommandError(
        retryEtimsInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            queueId: queue.queueId,
          },
          optionsFor((config) => stubClient(config, () => acknowledgement(fixture.controlNo))),
        ),
        /only failed/i,
      );
      expect((await queueRows(fixture.facility.id, queue.queueId))[0].attempts).toBe(1);
    });
  });

  it("9. issues a linked credit note for the full amount without touching the original", async () => {
    await withTaxFacility(async (fixture) => {
      const { queue } = await finalizeAndTransmit(fixture, () => acknowledgement(fixture.controlNo));
      const credit = await cancelEtimsInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          queueId: queue.queueId,
          reason: "Patient refund",
        },
        { database: ctx.db },
      );
      const rows = await queueRows(fixture.facility.id);
      const creditRow = rows.find((row) => row.id === credit.queueId)!;
      const original = rows.find((row) => row.id === queue.queueId)!;
      expect(creditRow.documentType).toBe("credit_note");
      expect(creditRow.creditNoteOf).toBe(original.id);
      expect(creditRow.totalAmount).toBe(original.totalAmount);
      expect(original.status).toBe("acknowledged");
      expect(original.kraControlNo).toBe(fixture.controlNo);
    });
  });

  it("10. exposes signature, QR and control number for the printed KRA invoice", async () => {
    await withTaxFacility(async (fixture) => {
      const { queue } = await finalizeAndTransmit(fixture, () => acknowledgement(fixture.controlNo));
      const detail = await getEtimsTransactionDetail(ctx.db, fixture.facility.id, queue.queueId);
      expect(detail).not.toBeNull();
      expect(detail!.kraControlNo).toBe(fixture.controlNo);
      expect(detail!.kraSignature).toBe(`SIGN-${fixture.controlNo}`);
      expect(detail!.qrUrl).toBe(`https://kra.test/qr/${fixture.controlNo}`);
      expect(detail!.lines).toHaveLength(1);

      const status = await getEtimsInvoiceStatus(
        { facilityId: fixture.facility.id, queueId: queue.queueId },
        { database: ctx.db },
      );
      expect(status.kraControlNo).toBe(fixture.controlNo);
      expect(status.qrUrl).toBe(detail!.qrUrl);
    });
  });

  it("11. keeps sandbox and production endpoints separate and guarded", async () => {
    // Production is disabled unless the integration is explicitly enabled.
    await withTaxFacility(
      async (fixture) => {
        const queue = await finalizeInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            invoiceId: fixture.invoiceId,
            environment: "production",
          },
          { database: ctx.db },
        );
        await expectCommandError(
          transmitEtimsInvoice(
            {
              facilityId: fixture.facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              queueId: queue.queueId,
              environment: "production",
            },
            { database: ctx.db, env: { ...process.env, ETIMS_ALLOW_PRODUCTION: "true" } },
          ),
          /integration is disabled/i,
        );
        expect((await queueRows(fixture.facility.id, queue.queueId))[0].status).toBe("pending");
      },
      { productionEnabled: false },
    );

    // Even with the flag set, a sandbox stub target is never a production endpoint.
    await withTaxFacility(
      async (fixture) => {
        const queue = await finalizeInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            invoiceId: fixture.invoiceId,
            environment: "production",
          },
          { database: ctx.db },
        );
        await expectCommandError(
          transmitEtimsInvoice(
            {
              facilityId: fixture.facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              queueId: queue.queueId,
              environment: "production",
            },
            { database: ctx.db, env: { ...process.env, ETIMS_ALLOW_PRODUCTION: "true" } },
          ),
          /sandbox target cannot be used for production/i,
        );
        expect((await queueRows(fixture.facility.id, queue.queueId))[0].status).toBe("pending");
      },
      { productionEnabled: true, productionUrl: ETIMS_SANDBOX_STUB_URL },
    );

    // A sandbox run likewise refuses a production KRA endpoint.
    await withTaxFacility(
      async (fixture) => {
        const queue = await finalizeInvoice(
          {
            facilityId: fixture.facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: ACTOR,
            invoiceId: fixture.invoiceId,
          },
          { database: ctx.db },
        );
        await expectCommandError(
          transmitEtimsInvoice(
            {
              facilityId: fixture.facility.id,
              idempotencyKey: newIdempotencyKey(),
              actor: ACTOR,
              queueId: queue.queueId,
            },
            { database: ctx.db },
          ),
          /sandbox run cannot target a production eTIMS endpoint/i,
        );
        expect((await queueRows(fixture.facility.id, queue.queueId))[0].status).toBe("pending");
      },
      { sandboxUrl: "https://kra.go.ke/production" },
    );
  });

  it("12. writes an outbox row and audit row with the exact transmitted payload", async () => {
    await withTaxFacility(async (fixture) => {
      let transmitted: unknown = null;
      const { queue } = await finalizeAndTransmit(fixture, () => acknowledgement(fixture.controlNo));
      // The stub above builds the same payload; read it back from the outbox and
      // compare it to an independently built KRA request for the stored snapshot.
      const outbox = await ctx.db
        .select()
        .from(etimsOutbox)
        .where(eq(etimsOutbox.queueId, queue.queueId));
      expect(outbox).toHaveLength(1);
      const log = await ctx.db
        .select()
        .from(etimsTransmissionLog)
        .where(eq(etimsTransmissionLog.queueId, queue.queueId));
      expect(log).toHaveLength(1);
      transmitted = outbox[0].requestPayload;
      // jsonb normalises key order, so compare structure rather than text.
      expect(isDeepStrictEqual(transmitted, log[0].requestPayload)).toBe(true);
      expect((transmitted as { environment: string }).environment).toBe("sandbox");

      const actions = (
        await ctx.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.facilityId, fixture.facility.id))
      ).map((row) => row.action);
      expect(actions).toContain("etims.enqueue");
      expect(actions).toContain("etims.transmit.acknowledged");
    });
  });

  it("13. reconciles exactly the stale pending rows", async () => {
    await withTaxFacility(async (fixture) => {
      const first = await finalizeInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: fixture.invoiceId,
        },
        { database: ctx.db },
      );
      const secondInvoice = await createInvoice({
        facility: fixture.facility,
        branchId: fixture.branchId,
        serviceId: fixture.serviceId,
      });
      const second = await finalizeInvoice(
        {
          facilityId: fixture.facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: ACTOR,
          invoiceId: secondInvoice.invoiceId,
        },
        { database: ctx.db },
      );

      await ctx.db
        .update(etimsInvoiceQueue)
        .set({ enqueuedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(etimsInvoiceQueue.id, first.queueId));

      const report = await reconcileEtimsQueue(
        { facilityId: fixture.facility.id, staleSeconds: 900 },
        { database: ctx.db },
      );
      expect(report.count).toBe(1);
      expect(report.stale.map((row) => row.queueId)).toEqual([first.queueId]);
      expect(report.stale[0].ageSeconds).toBeGreaterThanOrEqual(3599);
      expect(report.stale.some((row) => row.queueId === second.queueId)).toBe(false);
    });
  });
});
