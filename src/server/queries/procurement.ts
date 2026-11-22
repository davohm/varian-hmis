import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
  goodsReceiptLines,
  goodsReceipts,
  itemBatches,
  items,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequisitionApprovals as purchaseRequisitionApprovalsAlias,
  purchaseRequisitionLines,
  purchaseRequisitions,
  reorderLevels,
  rfqLines as rfqLinesAlias,
  rfqs,
  stockBalances,
  stores,
  supplierInvoiceLines,
  supplierInvoices,
  supplierPayments,
  supplierQuotes,
  suppliers,
} from "@/server/db/schema";

export type ProcurementDatabase = typeof db;

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export interface ProcurementOverview {
  pendingRequisitions: number;
  openPurchaseOrders: number;
  unpaidInvoiceCount: number;
  unpaidInvoiceAmount: string;
  stockValue: string;
  reorderAlerts: number;
}

export async function getProcurementOverview(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<ProcurementOverview> {
  const result = await database.execute(sql`
    SELECT
      (SELECT count(*)::int FROM purchase_requisitions
        WHERE facility_id = ${facilityId}::uuid AND status = 'draft') AS pending_requisitions,
      (SELECT count(*)::int FROM purchase_orders
        WHERE facility_id = ${facilityId}::uuid
          AND status IN ('draft', 'approved', 'partially_received')) AS open_purchase_orders,
      (SELECT count(*)::int FROM supplier_invoices
        WHERE facility_id = ${facilityId}::uuid AND status <> 'paid') AS unpaid_invoice_count,
      (SELECT coalesce(sum(amount - paid_amount), 0)::numeric(14,2) FROM supplier_invoices
        WHERE facility_id = ${facilityId}::uuid AND status <> 'paid') AS unpaid_invoice_amount,
      (SELECT coalesce(sum(sb.quantity * ib.unit_cost), 0)::numeric(14,2)
        FROM stock_balances sb
        JOIN item_batches ib ON ib.id = sb.batch_id
        WHERE sb.facility_id = ${facilityId}::uuid AND sb.quantity > 0) AS stock_value,
      (SELECT count(*)::int
        FROM reorder_levels rl
        WHERE rl.facility_id = ${facilityId}::uuid
          AND rl.active = true
          AND coalesce((
            SELECT sum(sb.quantity)
            FROM stock_balances sb
            WHERE sb.facility_id = rl.facility_id
              AND sb.item_id = rl.item_id
              AND sb.store_id = rl.store_id
          ), 0) < rl.minimum_quantity) AS reorder_alerts
  `);
  const row = (result as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};
  return {
    pendingRequisitions: Number(row.pending_requisitions ?? 0),
    openPurchaseOrders: Number(row.open_purchase_orders ?? 0),
    unpaidInvoiceCount: Number(row.unpaid_invoice_count ?? 0),
    unpaidInvoiceAmount: String(row.unpaid_invoice_amount ?? "0.00"),
    stockValue: String(row.stock_value ?? "0.00"),
    reorderAlerts: Number(row.reorder_alerts ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
  active: boolean;
}

export async function listSuppliers(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<SupplierRow[]> {
  return database
    .select({
      id: suppliers.id,
      code: suppliers.code,
      name: suppliers.name,
      contactName: suppliers.contactName,
      phone: suppliers.phone,
      email: suppliers.email,
      paymentTermsDays: suppliers.paymentTermsDays,
      active: suppliers.active,
    })
    .from(suppliers)
    .where(eq(suppliers.facilityId, facilityId))
    .orderBy(suppliers.name);
}

export interface ProcurementItemRow {
  id: string;
  code: string;
  name: string;
  unit: string;
}

export async function listProcurementItems(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<ProcurementItemRow[]> {
  return database
    .select({ id: items.id, code: items.code, name: items.name, unit: items.unit })
    .from(items)
    .where(eq(items.facilityId, facilityId))
    .orderBy(items.name);
}

export interface ProcurementStoreRow {
  id: string;
  name: string;
  kind: string;
}

export async function listProcurementStores(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<ProcurementStoreRow[]> {
  return database
    .select({ id: stores.id, name: stores.name, kind: stores.kind })
    .from(stores)
    .where(eq(stores.facilityId, facilityId))
    .orderBy(stores.name);
}

export interface RequisitionRow {
  id: string;
  requisitionNo: string;
  department: string;
  justification: string;
  status: string;
  totalAmount: string;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export async function listRequisitions(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<RequisitionRow[]> {
  return database
    .select({
      id: purchaseRequisitions.id,
      requisitionNo: purchaseRequisitions.requisitionNo,
      department: purchaseRequisitions.department,
      justification: purchaseRequisitions.justification,
      status: purchaseRequisitions.status,
      totalAmount: purchaseRequisitions.totalAmount,
      requestedBy: purchaseRequisitions.requestedBy,
      approvedBy: purchaseRequisitions.approvedBy,
      approvedAt: purchaseRequisitions.approvedAt,
      createdAt: purchaseRequisitions.createdAt,
    })
    .from(purchaseRequisitions)
    .where(eq(purchaseRequisitions.facilityId, facilityId))
    .orderBy(desc(purchaseRequisitions.createdAt));
}

export async function getRequisition(
  database: ProcurementDatabase,
  facilityId: string,
  requisitionId: string,
) {
  const header = await database
    .select()
    .from(purchaseRequisitions)
    .where(
      and(
        eq(purchaseRequisitions.id, requisitionId),
        eq(purchaseRequisitions.facilityId, facilityId),
      ),
    )
    .limit(1);
  if (!header[0]) return null;
  const lines = await database
    .select({
      id: purchaseRequisitionLines.id,
      itemId: purchaseRequisitionLines.itemId,
      itemName: items.name,
      quantity: purchaseRequisitionLines.quantity,
      unitCost: purchaseRequisitionLines.unitCost,
      lineTotal: purchaseRequisitionLines.lineTotal,
    })
    .from(purchaseRequisitionLines)
    .innerJoin(items, eq(items.id, purchaseRequisitionLines.itemId))
    .where(eq(purchaseRequisitionLines.requisitionId, requisitionId));
  const approvals = await database
    .select({
      id: purchaseRequisitionApprovalsAlias.id,
      decision: purchaseRequisitionApprovalsAlias.decision,
      actorId: purchaseRequisitionApprovalsAlias.actorId,
      reason: purchaseRequisitionApprovalsAlias.reason,
      decidedAt: purchaseRequisitionApprovalsAlias.decidedAt,
    })
    .from(purchaseRequisitionApprovalsAlias)
    .where(eq(purchaseRequisitionApprovalsAlias.requisitionId, requisitionId));
  return { ...header[0], lines, approvals };
}

export interface RfqRow {
  id: string;
  rfqNo: string;
  requisitionId: string;
  status: string;
  closingDate: string | null;
  issuedBy: string;
  createdAt: Date;
}

export async function listRfqs(database: ProcurementDatabase, facilityId: string): Promise<RfqRow[]> {
  return database
    .select({
      id: rfqs.id,
      rfqNo: rfqs.rfqNo,
      requisitionId: rfqs.requisitionId,
      status: rfqs.status,
      closingDate: rfqs.closingDate,
      issuedBy: rfqs.issuedBy,
      createdAt: rfqs.createdAt,
    })
    .from(rfqs)
    .where(eq(rfqs.facilityId, facilityId))
    .orderBy(desc(rfqs.createdAt));
}

export interface QuoteRow {
  id: string;
  rfqId: string;
  supplierId: string;
  supplierName: string;
  quoteNo: string | null;
  status: string;
  totalAmount: string;
  receivedAt: Date;
}

export async function listSupplierQuotes(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<QuoteRow[]> {
  return database
    .select({
      id: supplierQuotes.id,
      rfqId: supplierQuotes.rfqId,
      supplierId: supplierQuotes.supplierId,
      supplierName: suppliers.name,
      quoteNo: supplierQuotes.quoteNo,
      status: supplierQuotes.status,
      totalAmount: supplierQuotes.totalAmount,
      receivedAt: supplierQuotes.receivedAt,
    })
    .from(supplierQuotes)
    .innerJoin(suppliers, eq(suppliers.id, supplierQuotes.supplierId))
    .where(eq(supplierQuotes.facilityId, facilityId))
    .orderBy(desc(supplierQuotes.receivedAt));
}

export async function getRfq(database: ProcurementDatabase, facilityId: string, rfqId: string) {
  const header = await database
    .select()
    .from(rfqs)
    .where(and(eq(rfqs.id, rfqId), eq(rfqs.facilityId, facilityId)))
    .limit(1);
  if (!header[0]) return null;
  const lines = await database
    .select({
      id: rfqLinesAlias.id,
      itemId: rfqLinesAlias.itemId,
      itemName: items.name,
      quantity: rfqLinesAlias.quantity,
    })
    .from(rfqLinesAlias)
    .innerJoin(items, eq(items.id, rfqLinesAlias.itemId))
    .where(eq(rfqLinesAlias.rfqId, rfqId));
  const quotes = await listSupplierQuotes(database, facilityId);
  return { ...header[0], lines, quotes: quotes.filter((quote) => quote.rfqId === rfqId) };
}

export interface PurchaseOrderRow {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string;
  status: string;
  totalAmount: string;
  orderedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  expectedDate: string | null;
  createdAt: Date;
}

export async function listPurchaseOrders(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<PurchaseOrderRow[]> {
  return database
    .select({
      id: purchaseOrders.id,
      poNo: purchaseOrders.poNo,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      status: purchaseOrders.status,
      totalAmount: purchaseOrders.totalAmount,
      orderedBy: purchaseOrders.orderedBy,
      approvedBy: purchaseOrders.approvedBy,
      approvedAt: purchaseOrders.approvedAt,
      expectedDate: purchaseOrders.expectedDate,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(eq(purchaseOrders.facilityId, facilityId))
    .orderBy(desc(purchaseOrders.createdAt));
}

export async function getPurchaseOrder(
  database: ProcurementDatabase,
  facilityId: string,
  purchaseOrderId: string,
) {
  const header = await database
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.id, purchaseOrderId),
        eq(purchaseOrders.facilityId, facilityId),
      ),
    )
    .limit(1);
  if (!header[0]) return null;
  const lines = await database
    .select({
      id: purchaseOrderLines.id,
      itemId: purchaseOrderLines.itemId,
      itemName: items.name,
      quantity: purchaseOrderLines.quantity,
      receivedQuantity: purchaseOrderLines.receivedQuantity,
      unitCost: purchaseOrderLines.unitCost,
      lineTotal: purchaseOrderLines.lineTotal,
    })
    .from(purchaseOrderLines)
    .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
  return { ...header[0], lines };
}

export interface GoodsReceiptRow {
  id: string;
  grnNo: string;
  purchaseOrderId: string;
  poNo: string;
  storeId: string;
  storeName: string;
  totalAmount: string;
  receivedBy: string;
  receivedAt: Date;
  status: string;
}

export async function listGoodsReceipts(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<GoodsReceiptRow[]> {
  return database
    .select({
      id: goodsReceipts.id,
      grnNo: goodsReceipts.grnNo,
      purchaseOrderId: goodsReceipts.purchaseOrderId,
      poNo: purchaseOrders.poNo,
      storeId: goodsReceipts.storeId,
      storeName: stores.name,
      totalAmount: goodsReceipts.totalAmount,
      receivedBy: goodsReceipts.receivedBy,
      receivedAt: goodsReceipts.receivedAt,
      status: goodsReceipts.status,
    })
    .from(goodsReceipts)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
    .innerJoin(stores, eq(stores.id, goodsReceipts.storeId))
    .where(eq(goodsReceipts.facilityId, facilityId))
    .orderBy(desc(goodsReceipts.receivedAt));
}

export async function getGoodsReceipt(
  database: ProcurementDatabase,
  facilityId: string,
  goodsReceiptId: string,
) {
  const header = await database
    .select()
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.id, goodsReceiptId), eq(goodsReceipts.facilityId, facilityId)))
    .limit(1);
  if (!header[0]) return null;
  const lines = await database
    .select({
      id: goodsReceiptLines.id,
      purchaseOrderLineId: goodsReceiptLines.purchaseOrderLineId,
      itemId: goodsReceiptLines.itemId,
      itemName: items.name,
      batchNo: itemBatches.batchNo,
      expiryDate: goodsReceiptLines.expiryDate,
      quantity: goodsReceiptLines.quantity,
      unitCost: goodsReceiptLines.unitCost,
      lineTotal: goodsReceiptLines.lineTotal,
    })
    .from(goodsReceiptLines)
    .innerJoin(itemBatches, eq(itemBatches.id, goodsReceiptLines.batchId))
    .innerJoin(items, eq(items.id, goodsReceiptLines.itemId))
    .where(eq(goodsReceiptLines.goodsReceiptId, goodsReceiptId));
  return { ...header[0], lines };
}

export interface SupplierInvoiceRow {
  id: string;
  invoiceNo: string;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string;
  poNo: string;
  amount: string;
  paidAmount: string;
  status: string;
  invoiceDate: string;
  recordedBy: string;
}

export async function listSupplierInvoices(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<SupplierInvoiceRow[]> {
  return database
    .select({
      id: supplierInvoices.id,
      invoiceNo: supplierInvoices.invoiceNo,
      supplierId: supplierInvoices.supplierId,
      supplierName: suppliers.name,
      purchaseOrderId: supplierInvoices.purchaseOrderId,
      poNo: purchaseOrders.poNo,
      amount: supplierInvoices.amount,
      paidAmount: supplierInvoices.paidAmount,
      status: supplierInvoices.status,
      invoiceDate: supplierInvoices.invoiceDate,
      recordedBy: supplierInvoices.recordedBy,
    })
    .from(supplierInvoices)
    .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.purchaseOrderId))
    .where(eq(supplierInvoices.facilityId, facilityId))
    .orderBy(desc(supplierInvoices.invoiceDate));
}

export async function getSupplierInvoice(
  database: ProcurementDatabase,
  facilityId: string,
  supplierInvoiceId: string,
) {
  const header = await database
    .select()
    .from(supplierInvoices)
    .where(
      and(
        eq(supplierInvoices.id, supplierInvoiceId),
        eq(supplierInvoices.facilityId, facilityId),
      ),
    )
    .limit(1);
  if (!header[0]) return null;
  const lines = await database
    .select({
      id: supplierInvoiceLines.id,
      goodsReceiptLineId: supplierInvoiceLines.goodsReceiptLineId,
      itemId: supplierInvoiceLines.itemId,
      itemName: items.name,
      quantity: supplierInvoiceLines.quantity,
      unitCost: supplierInvoiceLines.unitCost,
      lineTotal: supplierInvoiceLines.lineTotal,
    })
    .from(supplierInvoiceLines)
    .innerJoin(items, eq(items.id, supplierInvoiceLines.itemId))
    .where(eq(supplierInvoiceLines.invoiceId, supplierInvoiceId));
  const payments = await database
    .select()
    .from(supplierPayments)
    .where(eq(supplierPayments.invoiceId, supplierInvoiceId));
  return { ...header[0], lines, payments };
}

export interface SupplierPaymentRow {
  id: string;
  paymentNo: string;
  supplierId: string;
  supplierName: string;
  invoiceId: string;
  invoiceNo: string;
  amount: string;
  paymentDate: string;
  method: string;
  recordedBy: string;
}

export async function listSupplierPayments(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<SupplierPaymentRow[]> {
  return database
    .select({
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      supplierId: supplierPayments.supplierId,
      supplierName: suppliers.name,
      invoiceId: supplierPayments.invoiceId,
      invoiceNo: supplierInvoices.invoiceNo,
      amount: supplierPayments.amount,
      paymentDate: supplierPayments.paymentDate,
      method: supplierPayments.method,
      recordedBy: supplierPayments.recordedBy,
    })
    .from(supplierPayments)
    .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierPayments.invoiceId))
    .where(eq(supplierPayments.facilityId, facilityId))
    .orderBy(desc(supplierPayments.paymentDate));
}

/* ------------------------------------------------------------------ */
/* Inventory reports                                                   */
/* ------------------------------------------------------------------ */

export interface ReorderRow {
  itemId: string;
  itemName: string;
  itemCode: string;
  storeId: string;
  storeName: string;
  minimumQuantity: number;
  quantityOnHand: number;
  reorderNeeded: boolean;
}

export async function listReorderRows(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<ReorderRow[]> {
  const levels = await database
    .select({
      itemId: reorderLevels.itemId,
      itemName: items.name,
      itemCode: items.code,
      storeId: reorderLevels.storeId,
      storeName: stores.name,
      minimumQuantity: reorderLevels.minimumQuantity,
    })
    .from(reorderLevels)
    .innerJoin(items, eq(items.id, reorderLevels.itemId))
    .innerJoin(stores, eq(stores.id, reorderLevels.storeId))
    .where(and(eq(reorderLevels.facilityId, facilityId), eq(reorderLevels.active, true)))
    .orderBy(items.name);

  const balances = await database
    .select({
      itemId: stockBalances.itemId,
      storeId: stockBalances.storeId,
      quantity: sql<number>`coalesce(sum(${stockBalances.quantity}), 0)::int`.as("quantity"),
    })
    .from(stockBalances)
    .where(eq(stockBalances.facilityId, facilityId))
    .groupBy(stockBalances.itemId, stockBalances.storeId);
  const balanceMap = new Map(
    balances.map((row) => [`${row.itemId}:${row.storeId}`, Number(row.quantity)]),
  );

  return levels.map((level) => {
    const quantityOnHand = balanceMap.get(`${level.itemId}:${level.storeId}`) ?? 0;
    return {
      ...level,
      quantityOnHand,
      reorderNeeded: quantityOnHand < level.minimumQuantity,
    };
  });
}

export interface StockValuationRow {
  itemId: string;
  itemName: string;
  itemCode: string;
  batchId: string | null;
  batchNo: string | null;
  expiryDate: string | null;
  quantity: number;
  unitCost: string;
  value: string;
}

export async function getStockValuation(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<StockValuationRow[]> {
  const rows = await database
    .select({
      itemId: stockBalances.itemId,
      itemName: items.name,
      itemCode: items.code,
      batchId: stockBalances.batchId,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      quantity: sql<number>`sum(${stockBalances.quantity})::int`.as("quantity"),
      unitCost: itemBatches.unitCost,
      value: sql<string>`sum(${stockBalances.quantity} * ${itemBatches.unitCost})::numeric(14,2)`.as("value"),
    })
    .from(stockBalances)
    .innerJoin(itemBatches, eq(itemBatches.id, stockBalances.batchId))
    .innerJoin(items, eq(items.id, stockBalances.itemId))
    .where(eq(stockBalances.facilityId, facilityId))
    .groupBy(
      stockBalances.itemId,
      items.name,
      items.code,
      stockBalances.batchId,
      itemBatches.batchNo,
      itemBatches.expiryDate,
      itemBatches.unitCost,
    )
    .having(sql`sum(${stockBalances.quantity}) > 0`)
    .orderBy(items.name);
  return rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

export interface ExpiryRow {
  batchId: string;
  itemName: string;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
}

export async function getExpiryReport(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<ExpiryRow[]> {
  const rows = await database
    .select({
      batchId: itemBatches.id,
      itemName: items.name,
      batchNo: itemBatches.batchNo,
      expiryDate: itemBatches.expiryDate,
      quantity: sql<number>`coalesce(sum(${stockBalances.quantity}), 0)::int`.as("quantity"),
    })
    .from(itemBatches)
    .innerJoin(items, eq(items.id, itemBatches.itemId))
    .leftJoin(stockBalances, eq(stockBalances.batchId, itemBatches.id))
    .where(eq(itemBatches.facilityId, facilityId))
    .groupBy(itemBatches.id, items.name, itemBatches.batchNo, itemBatches.expiryDate)
    .having(sql`coalesce(sum(${stockBalances.quantity}), 0) > 0`)
    .orderBy(itemBatches.expiryDate);
  return rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

export interface ThreeWayVarianceRow {
  purchaseOrderId: string;
  poNo: string;
  goodsReceiptId: string;
  grnNo: string;
  orderedAmount: string;
  receivedAmount: string;
  invoicedAmount: string;
}

export async function getThreeWayVarianceReport(
  database: ProcurementDatabase,
  facilityId: string,
): Promise<ThreeWayVarianceRow[]> {
  const result = await database.execute(sql`
    SELECT
      po.id AS "purchaseOrderId",
      po.po_no AS "poNo",
      gr.id AS "goodsReceiptId",
      gr.grn_no AS "grnNo",
      po.total_amount AS "orderedAmount",
      gr.total_amount AS "receivedAmount",
      coalesce(sum(si.amount), 0)::numeric(14,2) AS "invoicedAmount"
    FROM purchase_orders po
    JOIN goods_receipts gr ON gr.purchase_order_id = po.id
    LEFT JOIN supplier_invoices si ON si.purchase_order_id = po.id
    WHERE po.facility_id = ${facilityId}::uuid
    GROUP BY po.id, po.po_no, gr.id, gr.grn_no, po.total_amount, gr.total_amount
    ORDER BY po.created_at DESC
  `);
  return (result as unknown as { rows?: ThreeWayVarianceRow[] }).rows ?? [];
}
