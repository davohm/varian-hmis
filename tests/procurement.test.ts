import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertBalancedJournal, DEFAULT_CHART_OF_ACCOUNTS } from "../src/lib/finance";
import { matchesThreeWay } from "../src/lib/procurement";
import { newId, newIdempotencyKey } from "../src/lib/uuid";
import { createLedgerAccount, setFinanceApprovalLimit } from "../src/server/commands/finance";
import {
  approvePurchaseOrder,
  approvePurchaseRequisition,
  createPurchaseOrder,
  createPurchaseRequisition,
  createRfq,
  createSupplier,
  recordSupplierInvoice,
  recordSupplierPayment,
  recordSupplierQuote,
  receiveGoods,
  selectSupplierQuote,
  setReorderLevel,
} from "../src/server/commands/procurement";
import {
  auditLog,
  journalEntries,
  journalLines,
  purchaseOrders,
  purchaseRequisitions,
  staffRoleScopes,
  stockLedger,
  stores,
  supplierInvoices,
  supplierPayments,
  syncOutbox,
  items,
  user,
} from "../src/server/db/schema";
import {
  getGoodsReceipt,
  getProcurementOverview,
  getPurchaseOrder,
  getRfq,
  getStockValuation,
  getSupplierInvoice,
  listReorderRows,
  listSupplierPayments,
  listSupplierQuotes,
} from "../src/server/queries/procurement";

import {
  cleanupTestFacility,
  createTestDatabase,
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

type Role =
  | "admin"
  | "procurement_officer"
  | "store_manager"
  | "accountant"
  | "finance_officer";

interface ProcurementActor {
  userId: string;
  deviceId: string;
  ip: string;
}

interface ProcurementFixture {
  facility: { id: string; code: string };
  storeId: string;
  suffix: string;
  itemA: { id: string; code: string; name: string; unit: string };
  itemB: { id: string; code: string; name: string; unit: string };
  supplierId: string;
  alternateSupplierId: string;
  accounts: Record<string, string>;
  actors: {
    requester: ProcurementActor;
    approver: ProcurementActor;
    purchaser: ProcurementActor;
    receiver: ProcurementActor;
    invoiceRecorder: ProcurementActor;
    payer: ProcurementActor;
    seniorPayer: ProcurementActor;
    admin: ProcurementActor;
  };
}

function actorOf(userId: string, label: string): ProcurementActor {
  return { userId, deviceId: `procurement-${label}`, ip: "127.0.0.1" };
}

async function insertRoleActor(
  facilityId: string,
  role: Role,
  label: string,
): Promise<ProcurementActor> {
  const userId = await insertTestActor(ctx.db);
  if (role !== "admin") {
    await ctx.db.update(user).set({ role: "user" }).where(eq(user.id, userId));
  }
  await ctx.db.insert(staffRoleScopes).values({ userId, role, facilityId });
  return actorOf(userId, label);
}

/** Drizzle wraps driver errors, so walk the cause chain for the database message. */
async function expectDatabaseError(promise: PromiseLike<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(" | ")).toMatch(pattern);
    return;
  }
  throw new Error(`Expected the database to reject this query (${pattern})`);
}

async function withProcurementFacility<T>(
  run: (fixture: ProcurementFixture) => Promise<T>,
): Promise<T> {
  const facility = await insertTestFacility(ctx.db);
  const branchId = await insertTestBranch(ctx.db, facility.id);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const storeId = newId();
  await ctx.db.insert(stores).values({
    id: storeId,
    facilityId: facility.id,
    branchId,
    name: "Main Store",
    kind: "main",
    createdBy: "vitest",
  });

  const itemA = {
    id: newId(),
    code: `CONA${suffix}`,
    name: `Consumable A ${suffix}`,
    unit: "unit",
  };
  const itemB = {
    id: newId(),
    code: `CONB${suffix}`,
    name: `Consumable B ${suffix}`,
    unit: "unit",
  };
  await ctx.db.insert(items).values([
    {
      id: itemA.id,
      facilityId: facility.id,
      code: itemA.code,
      name: itemA.name,
      kind: "consumable",
      unit: itemA.unit,
      createdBy: "vitest",
    },
    {
      id: itemB.id,
      facilityId: facility.id,
      code: itemB.code,
      name: itemB.name,
      kind: "consumable",
      unit: itemB.unit,
      createdBy: "vitest",
    },
  ]);

  const actors = {
    requester: await insertRoleActor(facility.id, "procurement_officer", "requester"),
    approver: await insertRoleActor(facility.id, "procurement_officer", "approver"),
    purchaser: await insertRoleActor(facility.id, "procurement_officer", "purchaser"),
    receiver: await insertRoleActor(facility.id, "store_manager", "receiver"),
    invoiceRecorder: await insertRoleActor(facility.id, "accountant", "invoice-recorder"),
    payer: await insertRoleActor(facility.id, "accountant", "payer"),
    seniorPayer: await insertRoleActor(facility.id, "finance_officer", "senior-payer"),
    admin: await insertRoleActor(facility.id, "admin", "admin"),
  };

  const accounts: Record<string, string> = {};
  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    const created = await createLedgerAccount(
      {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: actors.admin,
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

  const supplier = await createSupplier(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: actors.admin,
      code: `SUP${suffix}`,
      name: `Supplier ${suffix}`,
      paymentTermsDays: 30,
    },
    { database: ctx.db },
  );
  const alternate = await createSupplier(
    {
      facilityId: facility.id,
      idempotencyKey: newIdempotencyKey(),
      actor: actors.admin,
      code: `ALT${suffix}`,
      name: `Alternate Supplier ${suffix}`,
    },
    { database: ctx.db },
  );

  try {
    return await run({
      facility,
      storeId,
      suffix,
      itemA,
      itemB,
      supplierId: supplier.supplierId,
      alternateSupplierId: alternate.supplierId,
      accounts,
      actors,
    });
  } finally {
    await cleanupTestFacility(ctx.db, facility.id);
  }
}

describe("procurement rules", () => {
  it("matches three-way documents only when quantity and unit cost are identical", () => {
    const order = { quantity: 10, unitCostCents: 2500 };
    const receipt = { quantity: 10, unitCostCents: 2500 };

    expect(matchesThreeWay(order, receipt, { quantity: 10, unitCostCents: 2500 })).toBe(true);
    expect(matchesThreeWay(order, receipt, { quantity: 9, unitCostCents: 2500 })).toBe(false);
    expect(matchesThreeWay(order, receipt, { quantity: 10, unitCostCents: 2600 })).toBe(false);
    expect(
      matchesThreeWay(order, { quantity: 9, unitCostCents: 2500 }, {
        quantity: 9,
        unitCostCents: 2500,
      }),
    ).toBe(false);
  });
});

describe("procurement workflow", () => {
  it("runs requisition to payment as one audited stock, AP and GL chain", async () => {
    await withProcurementFacility(async (fixture) => {
      const { facility, actors, itemA, itemB, suffix, supplierId, alternateSupplierId } = fixture;

      // Supplier creation is idempotent; the same key returns the same master row.
      const supplierInput = {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: actors.admin,
        code: `IDEM${suffix}`,
        name: `Idempotent Supplier ${suffix}`,
      };
      const supplier = await createSupplier(supplierInput, { database: ctx.db });
      const replay = await createSupplier(supplierInput, { database: ctx.db });
      expect(replay.supplierId).toBe(supplier.supplierId);

      const requisition = await createPurchaseRequisition(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.requester,
          department: "Operations",
          justification: "Restock consumables for the quarter",
          lines: [
            { itemId: itemA.id, quantity: 10, unitCost: "25.00" },
            { itemId: itemB.id, quantity: 4, unitCost: "100.00" },
          ],
        },
        { database: ctx.db },
      );
      expect(requisition.total).toBe("650.00");
      expect(requisition.requisitionNo).toMatch(
        /^TEST-[A-Z0-9]+-RQ-\d{2}-\d{6}$/,
      );

      await expect(
        approvePurchaseRequisition(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actors.requester,
            requisitionId: requisition.requisitionId,
            decision: "approved",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot approve their own requisition/i);

      await approvePurchaseRequisition(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.approver,
          requisitionId: requisition.requisitionId,
          decision: "approved",
        },
        { database: ctx.db },
      );
      const [approvedRequisition] = await ctx.db
        .select()
        .from(purchaseRequisitions)
        .where(eq(purchaseRequisitions.id, requisition.requisitionId));
      expect(approvedRequisition.status).toBe("approved");
      expect(approvedRequisition.approvedBy).toBe(actors.approver.userId);

      const rfq = await createRfq(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.purchaser,
          requisitionId: requisition.requisitionId,
          closingDate: "2026-12-31",
        },
        { database: ctx.db },
      );
      expect(rfq.lineCount).toBe(2);
      expect(rfq.rfqNo).toMatch(/^TEST-[A-Z0-9]+-RFQ-\d{2}-\d{5}$/);

      const quoteLines = [
        { itemId: itemA.id, quantity: 10, unitCost: "25.00", leadTimeDays: 7 },
        { itemId: itemB.id, quantity: 4, unitCost: "100.00", leadTimeDays: 7 },
      ];
      const preferredQuote = await recordSupplierQuote(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.purchaser,
          rfqId: rfq.rfqId,
          supplierId,
          quoteNo: `Q-${suffix}-A`,
          lines: quoteLines,
        },
        { database: ctx.db },
      );
      const alternateQuote = await recordSupplierQuote(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.purchaser,
          rfqId: rfq.rfqId,
          supplierId: alternateSupplierId,
          quoteNo: `Q-${suffix}-B`,
          lines: [
            { itemId: itemA.id, quantity: 10, unitCost: "28.00", leadTimeDays: 5 },
            { itemId: itemB.id, quantity: 4, unitCost: "110.00", leadTimeDays: 5 },
          ],
        },
        { database: ctx.db },
      );
      expect(preferredQuote.total).toBe("650.00");
      expect(alternateQuote.total).toBe("720.00");

      await selectSupplierQuote(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.purchaser,
          quoteId: preferredQuote.quoteId,
          reason: "Lowest evaluated total",
        },
        { database: ctx.db },
      );
      const quotes = await listSupplierQuotes(ctx.db, facility.id);
      expect(quotes).toHaveLength(2);
      expect(
        quotes.find((quote) => quote.id === preferredQuote.quoteId)?.status,
      ).toBe("selected");
      expect(
        quotes.find((quote) => quote.id === alternateQuote.quoteId)?.status,
      ).toBe("rejected");
      const closedRfq = await getRfq(ctx.db, facility.id, rfq.rfqId);
      expect(closedRfq?.status).toBe("closed");

      const purchaseOrder = await createPurchaseOrder(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.purchaser,
          quoteId: preferredQuote.quoteId,
          expectedDate: "2026-12-15",
        },
        { database: ctx.db },
      );
      expect(purchaseOrder.total).toBe("650.00");
      expect(purchaseOrder.poNo).toMatch(/^TEST-[A-Z0-9]+-PO-\d{2}-\d{6}$/);

      await expect(
        approvePurchaseOrder(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actors.purchaser,
            purchaseOrderId: purchaseOrder.purchaseOrderId,
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot approve their own purchase order/i);
      await approvePurchaseOrder(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.approver,
          purchaseOrderId: purchaseOrder.purchaseOrderId,
          note: "Within delegated authority",
        },
        { database: ctx.db },
      );

      await setReorderLevel(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.receiver,
          itemId: itemA.id,
          storeId: fixture.storeId,
          minimumQuantity: 5,
        },
        { database: ctx.db },
      );
      expect((await getProcurementOverview(ctx.db, facility.id)).reorderAlerts).toBe(1);

      const orderBeforeReceipt = await getPurchaseOrder(
        ctx.db,
        facility.id,
        purchaseOrder.purchaseOrderId,
      );
      const lineA = orderBeforeReceipt!.lines.find((line) => line.itemId === itemA.id)!;
      const lineB = orderBeforeReceipt!.lines.find((line) => line.itemId === itemB.id)!;

      const receiptInput = {
        facilityId: facility.id,
        idempotencyKey: newIdempotencyKey(),
        actor: actors.receiver,
        purchaseOrderId: purchaseOrder.purchaseOrderId,
        storeId: fixture.storeId,
        lines: [
          {
            purchaseOrderLineId: lineA.id,
            batchNo: `BA-${suffix}`,
            expiryDate: "2027-12-31",
            quantity: 10,
            unitCost: "25.00",
          },
          {
            purchaseOrderLineId: lineB.id,
            batchNo: `BB-${suffix}`,
            quantity: 4,
            unitCost: "100.00",
          },
        ],
      };
      await expect(
        receiveGoods(
          { ...receiptInput, actor: actors.purchaser, idempotencyKey: newIdempotencyKey() },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot receive goods against their own purchase order/i);
      await expect(
        receiveGoods(
          { ...receiptInput, actor: actors.approver, idempotencyKey: newIdempotencyKey() },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot receive goods they approved/i);

      const receipt = await receiveGoods(receiptInput, { database: ctx.db });
      expect(receipt.total).toBe("650.00");
      expect(receipt.grnNo).toMatch(/^TEST-[A-Z0-9]+-GRN-\d{2}-\d{5}$/);

      const stockRows = await ctx.db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.facilityId, facility.id));
      expect(stockRows).toHaveLength(2);
      expect(
        stockRows.every(
          (row) =>
            row.refType === "goods_receipt" && row.reason === "receive" && row.qtyDelta > 0,
        ),
      ).toBe(true);

      const valuation = await getStockValuation(ctx.db, facility.id);
      expect(valuation.reduce((sum, row) => sum + Number(row.value), 0)).toBe(650);
      const receivedOverview = await getProcurementOverview(ctx.db, facility.id);
      expect(receivedOverview.stockValue).toBe("650.00");
      expect(receivedOverview.reorderAlerts).toBe(0);
      const reorderRows = await listReorderRows(ctx.db, facility.id);
      expect(reorderRows).toHaveLength(1);
      expect(reorderRows[0]).toMatchObject({ quantityOnHand: 10, reorderNeeded: false });

      const orderAfterReceipt = await getPurchaseOrder(
        ctx.db,
        facility.id,
        purchaseOrder.purchaseOrderId,
      );
      expect(orderAfterReceipt?.status).toBe("received");
      const receiptDetail = await getGoodsReceipt(ctx.db, facility.id, receipt.goodsReceiptId);
      expect(receiptDetail?.lines).toHaveLength(2);

      const invoiceLines = receiptDetail!.lines.map((line) => ({
        goodsReceiptLineId: line.id,
        quantity: line.quantity,
        unitCost: line.unitCost,
      }));
      await expect(
        recordSupplierInvoice(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actors.invoiceRecorder,
            purchaseOrderId: purchaseOrder.purchaseOrderId,
            goodsReceiptId: receipt.goodsReceiptId,
            supplierId,
            invoiceNo: `MISMATCH-${suffix}`,
            invoiceDate: "2026-11-20",
            lines: invoiceLines.map((line, index) =>
              index === 0 ? { ...line, unitCost: "26.00" } : line,
            ),
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/three-way match failed/i);
      expect(
        await ctx.db
          .select({ id: supplierInvoices.id })
          .from(supplierInvoices)
          .where(eq(supplierInvoices.facilityId, facility.id)),
      ).toHaveLength(0);

      const invoice = await recordSupplierInvoice(
        {
          facilityId: facility.id,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.invoiceRecorder,
          purchaseOrderId: purchaseOrder.purchaseOrderId,
          goodsReceiptId: receipt.goodsReceiptId,
          supplierId,
          invoiceNo: `SINV-${suffix}`,
          invoiceDate: "2026-11-20",
          lines: invoiceLines,
        },
        { database: ctx.db },
      );
      expect(invoice.total).toBe("650.00");

      const invoiceJournals = await ctx.db
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.facilityId, facility.id),
            eq(journalEntries.sourceType, "supplier_invoice"),
          ),
        );
      expect(invoiceJournals).toHaveLength(1);
      expect(invoiceJournals[0].sourceId).toBe(invoice.supplierInvoiceId);
      const invoiceJournalLines = await ctx.db
        .select()
        .from(journalLines)
        .where(eq(journalLines.entryId, invoiceJournals[0].id));
      expect(assertBalancedJournal(invoiceJournalLines).debit).toBe("650.00");
      expect(
        invoiceJournalLines.find((line) => line.accountId === fixture.accounts.inventory)?.debit,
      ).toBe("650.00");
      expect(
        invoiceJournalLines.find(
          (line) => line.accountId === fixture.accounts.accounts_payable,
        )?.credit,
      ).toBe("650.00");
      expect((await getProcurementOverview(ctx.db, facility.id)).unpaidInvoiceAmount).toBe(
        "650.00",
      );

      for (const limit of [
        { role: "accountant" as const, maxAmount: "300.00" },
        { role: "finance_officer" as const, maxAmount: "1000.00" },
      ]) {
        await setFinanceApprovalLimit(
          {
            facilityId: facility.id,
            idempotencyKey: newIdempotencyKey(),
            actor: actors.admin,
            action: "recordSupplierPayment",
            role: limit.role,
            maxAmount: limit.maxAmount,
          },
          { database: ctx.db },
        );
      }

      const paymentBase = {
        facilityId: facility.id,
        supplierInvoiceId: invoice.supplierInvoiceId,
        paymentDate: "2026-11-21",
        method: "bank" as const,
      };
      await expect(
        recordSupplierPayment(
          {
            ...paymentBase,
            idempotencyKey: newIdempotencyKey(),
            actor: actors.invoiceRecorder,
            amount: "650.00",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/same user cannot prepare and pay the same supplier invoice/i);
      await expect(
        recordSupplierPayment(
          {
            ...paymentBase,
            idempotencyKey: newIdempotencyKey(),
            actor: actors.payer,
            amount: "400.00",
          },
          { database: ctx.db },
        ),
      ).rejects.toThrow(/exceeds your approval limit/i);

      const firstPayment = await recordSupplierPayment(
        {
          ...paymentBase,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.payer,
          amount: "250.00",
          reference: `PAY-${suffix}-1`,
        },
        { database: ctx.db },
      );
      expect(firstPayment.paymentNo).toMatch(/^TEST-[A-Z0-9]+-SPAY-\d{2}-\d{5}$/);
      expect((await getSupplierInvoice(ctx.db, facility.id, invoice.supplierInvoiceId))?.status).toBe(
        "partially_paid",
      );

      const secondPayment = await recordSupplierPayment(
        {
          ...paymentBase,
          idempotencyKey: newIdempotencyKey(),
          actor: actors.seniorPayer,
          amount: "400.00",
          reference: `PAY-${suffix}-2`,
        },
        { database: ctx.db },
      );
      const settled = await getSupplierInvoice(ctx.db, facility.id, invoice.supplierInvoiceId);
      expect(settled?.status).toBe("paid");
      expect(settled?.paidAmount).toBe("650.00");
      expect(settled?.payments).toHaveLength(2);
      expect((await getProcurementOverview(ctx.db, facility.id)).unpaidInvoiceAmount).toBe(
        "0.00",
      );
      const finalOrder = await ctx.db
        .select({ status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, purchaseOrder.purchaseOrderId));
      expect(finalOrder[0].status).toBe("paid");

      const paymentJournals = await ctx.db
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.facilityId, facility.id),
            eq(journalEntries.sourceType, "supplier_payment"),
          ),
        );
      expect(paymentJournals).toHaveLength(2);
      for (const entry of paymentJournals) {
        const lines = await ctx.db
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, entry.id));
        expect(assertBalancedJournal(lines)).toMatchObject({ balanced: true });
        expect(
          lines.some(
            (line) => line.accountId === fixture.accounts.accounts_payable && Number(line.debit) > 0,
          ),
        ).toBe(true);
        expect(
          lines.some(
            (line) => line.accountId === fixture.accounts.bank && Number(line.credit) > 0,
          ),
        ).toBe(true);
      }
      expect(await listSupplierPayments(ctx.db, facility.id)).toHaveLength(2);

      await expectDatabaseError(
        ctx.db
          .update(supplierPayments)
          .set({ amount: "1.00" })
          .where(eq(supplierPayments.id, firstPayment.supplierPaymentId)),
        /supplier_payments is append-only/i,
      );
      await expectDatabaseError(
        ctx.db
          .delete(supplierPayments)
          .where(eq(supplierPayments.id, secondPayment.supplierPaymentId)),
        /supplier_payments is append-only/i,
      );
      await expectDatabaseError(
        ctx.db
          .delete(supplierInvoices)
          .where(eq(supplierInvoices.id, invoice.supplierInvoiceId)),
        /supplier_invoices cannot be hard-deleted/i,
      );

      const procurementAudit = await ctx.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.facilityId, facility.id),
            sql`${auditLog.action} like 'procurement.%'`,
          ),
        );
      expect(procurementAudit.length).toBeGreaterThan(15);

      const outboxRows = await ctx.db
        .select({ tableName: syncOutbox.tableName })
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.facilityId, facility.id),
            inArray(syncOutbox.tableName, [
              "suppliers",
              "purchase_requisitions",
              "purchase_requisition_lines",
              "purchase_requisition_approvals",
              "rfqs",
              "rfq_lines",
              "supplier_quotes",
              "supplier_quote_lines",
              "purchase_orders",
              "purchase_order_lines",
              "goods_receipts",
              "goods_receipt_lines",
              "supplier_invoices",
              "supplier_invoice_lines",
              "supplier_payments",
              "reorder_levels",
            ]),
          ),
        );
      const capturedTables = new Set(outboxRows.map((row) => row.tableName));
      for (const table of [
        "suppliers",
        "purchase_requisitions",
        "purchase_requisition_approvals",
        "rfqs",
        "supplier_quotes",
        "purchase_orders",
        "goods_receipts",
        "supplier_invoices",
        "supplier_payments",
        "reorder_levels",
      ]) {
        expect(capturedTables.has(table)).toBe(true);
      }
    });
  });
});
