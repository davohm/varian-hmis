import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { PROCUREMENT_READ_ROLES, PROCUREMENT_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
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
} from "@/server/commands/procurement";
import { db } from "@/server/db/client";
import {
  getExpiryReport,
  getGoodsReceipt,
  getProcurementOverview,
  getPurchaseOrder,
  getRequisition,
  getRfq,
  getStockValuation,
  getSupplierInvoice,
  getThreeWayVarianceReport,
  listGoodsReceipts,
  listProcurementItems,
  listProcurementStores,
  listPurchaseOrders,
  listReorderRows,
  listRequisitions,
  listRfqs,
  listSupplierInvoices,
  listSupplierPayments,
  listSupplierQuotes,
  listSuppliers,
} from "@/server/queries/procurement";

import { handleErpCommand } from "./_shared";

export const dynamic = "force-dynamic";

const commands: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  createSupplier: (input) => createSupplier(input as Parameters<typeof createSupplier>[0]),
  createPurchaseRequisition: (input) =>
    createPurchaseRequisition(input as Parameters<typeof createPurchaseRequisition>[0]),
  approvePurchaseRequisition: (input) =>
    approvePurchaseRequisition(input as Parameters<typeof approvePurchaseRequisition>[0]),
  createRfq: (input) => createRfq(input as Parameters<typeof createRfq>[0]),
  recordSupplierQuote: (input) =>
    recordSupplierQuote(input as Parameters<typeof recordSupplierQuote>[0]),
  selectSupplierQuote: (input) =>
    selectSupplierQuote(input as Parameters<typeof selectSupplierQuote>[0]),
  createPurchaseOrder: (input) =>
    createPurchaseOrder(input as Parameters<typeof createPurchaseOrder>[0]),
  approvePurchaseOrder: (input) =>
    approvePurchaseOrder(input as Parameters<typeof approvePurchaseOrder>[0]),
  receiveGoods: (input) => receiveGoods(input as Parameters<typeof receiveGoods>[0]),
  recordSupplierInvoice: (input) =>
    recordSupplierInvoice(input as Parameters<typeof recordSupplierInvoice>[0]),
  recordSupplierPayment: (input) =>
    recordSupplierPayment(input as Parameters<typeof recordSupplierPayment>[0]),
  setReorderLevel: (input) => setReorderLevel(input as Parameters<typeof setReorderLevel>[0]),
};

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(PROCUREMENT_READ_ROLES);
    const url = new URL(request.url);
    const requisitionId = url.searchParams.get("requisitionId") ?? undefined;
    const rfqId = url.searchParams.get("rfqId") ?? undefined;
    const purchaseOrderId = url.searchParams.get("purchaseOrderId") ?? undefined;
    const goodsReceiptId = url.searchParams.get("goodsReceiptId") ?? undefined;
    const supplierInvoiceId = url.searchParams.get("supplierInvoiceId") ?? undefined;

    const [
      overview,
      suppliers,
      requisitions,
      requisitionDetail,
      rfqs,
      rfqDetail,
      quotes,
      purchaseOrders,
      purchaseOrderDetail,
      goodsReceipts,
      goodsReceiptDetail,
      supplierInvoices,
      supplierInvoiceDetail,
      supplierPayments,
      items,
      stores,
      reorderRows,
      stockValuation,
      expiryReport,
      varianceReport,
    ] = await Promise.all([
      getProcurementOverview(db, facilityId),
      listSuppliers(db, facilityId),
      listRequisitions(db, facilityId),
      requisitionId ? getRequisition(db, facilityId, requisitionId) : Promise.resolve(null),
      listRfqs(db, facilityId),
      rfqId ? getRfq(db, facilityId, rfqId) : Promise.resolve(null),
      listSupplierQuotes(db, facilityId),
      listPurchaseOrders(db, facilityId),
      purchaseOrderId ? getPurchaseOrder(db, facilityId, purchaseOrderId) : Promise.resolve(null),
      listGoodsReceipts(db, facilityId),
      goodsReceiptId ? getGoodsReceipt(db, facilityId, goodsReceiptId) : Promise.resolve(null),
      listSupplierInvoices(db, facilityId),
      supplierInvoiceId
        ? getSupplierInvoice(db, facilityId, supplierInvoiceId)
        : Promise.resolve(null),
      listSupplierPayments(db, facilityId),
      listProcurementItems(db, facilityId),
      listProcurementStores(db, facilityId),
      listReorderRows(db, facilityId),
      getStockValuation(db, facilityId),
      getExpiryReport(db, facilityId),
      getThreeWayVarianceReport(db, facilityId),
    ]);

    return NextResponse.json({
      overview,
      suppliers,
      requisitions,
      requisitionDetail,
      rfqs,
      rfqDetail,
      quotes,
      purchaseOrders,
      purchaseOrderDetail,
      goodsReceipts,
      goodsReceiptDetail,
      supplierInvoices,
      supplierInvoiceDetail,
      supplierPayments,
      items,
      stores,
      reorderRows,
      stockValuation,
      expiryReport,
      varianceReport,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(
    request,
    PROCUREMENT_WRITE_ROLES,
    commands,
    "Invalid procurement command",
  );
}
