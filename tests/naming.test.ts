import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allocateNumber, formatNumber } from "../src/server/numbering";
import { cleanupTestFacility, createTestDatabase, insertTestFacility, type TestDatabase } from "./helpers";

describe("numbering", () => {
  let ctx: TestDatabase;

  beforeAll(() => {
    ctx = createTestDatabase();
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  it("formats all document numbers from the same gap-free sequence", () => {
    const date = new Date(2026, 0, 15);
    expect(formatNumber("FAM", "mrn", 42, date)).toBe("FAM-26-00042");
    expect(formatNumber("FAM", "encounter", 123, date)).toBe("FAM-E-26-000123");
    expect(formatNumber("FAM", "invoice", 123, date)).toBe("FAM-I-26-000123");
    expect(formatNumber("FAM", "receipt", 123, date)).toBe("FAM-R-26-000123");
    expect(formatNumber("FAM", "requisition", 123, date)).toBe("FAM-RQ-26-000123");
    expect(formatNumber("FAM", "rfq", 123, date)).toBe("FAM-RFQ-26-00123");
    expect(formatNumber("FAM", "purchaseOrder", 123, date)).toBe("FAM-PO-26-000123");
    expect(formatNumber("FAM", "goodsReceipt", 123, date)).toBe("FAM-GRN-26-00123");
    expect(formatNumber("FAM", "supplierInvoice", 123, date)).toBe("FAM-SINV-26-00123");
    expect(formatNumber("FAM", "supplierPayment", 123, date)).toBe("FAM-SPAY-26-00123");
  });

  it("allocates 50 parallel numbers with no gaps and no duplicates", async () => {
    const facility = await insertTestFacility(ctx.db);

    try {
      const scope = `concurrency-${facility.id}`;
      const values = await Promise.all(
        Array.from({ length: 50 }, () => allocateNumber(ctx.db, facility.id, scope)),
      );

      const sorted = [...values].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(new Set(sorted).size).toBe(50);
    } finally {
      await cleanupTestFacility(ctx.db, facility.id);
    }
  });
});
