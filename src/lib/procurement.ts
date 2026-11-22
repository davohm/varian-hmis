/** Shared procurement and inventory rules used by commands, queries and UI. */

export const REQUISITION_STATUSES = ["draft", "approved", "rejected", "ordered"] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export const REQUISITION_STATUS_LABELS: Record<RequisitionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  ordered: "Ordered",
};

export const RFQ_STATUSES = ["open", "closed"] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  open: "Open",
  closed: "Closed",
};

export const QUOTE_STATUSES = ["received", "selected", "rejected"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  received: "Received",
  selected: "Selected",
  rejected: "Rejected",
};

export const PURCHASE_ORDER_STATUSES = [
  "draft",
  "approved",
  "partially_received",
  "received",
  "invoiced",
  "paid",
  "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  partially_received: "Partially received",
  received: "Received",
  invoiced: "Invoiced",
  paid: "Paid",
  cancelled: "Cancelled",
};

export const SUPPLIER_INVOICE_STATUSES = ["posted", "partially_paid", "paid"] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

export const SUPPLIER_INVOICE_STATUS_LABELS: Record<SupplierInvoiceStatus, string> = {
  posted: "Posted",
  partially_paid: "Partially paid",
  paid: "Paid",
};

export const PAYMENT_METHODS = ["cash", "bank"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PROCUREMENT_APPROVAL_ACTIONS = [
  "approveRequisition",
  "approvePurchaseOrder",
  "recordSupplierPayment",
] as const;
export type ProcurementApprovalAction = (typeof PROCUREMENT_APPROVAL_ACTIONS)[number];

/** Procurement roles involved in the segregation-of-duties chain. */
export const PROCUREMENT_ROLES = ["procurement_officer", "store_manager"] as const;
export type ProcurementRole = (typeof PROCUREMENT_ROLES)[number];

export const PROCUREMENT_ROLE_LABELS: Record<ProcurementRole, string> = {
  procurement_officer: "Procurement Officer",
  store_manager: "Store Manager",
};

/**
 * Three-way matching compares purchase order, goods receipt and supplier
 * invoice amounts in cents. Exact equality keeps the rule auditable; a future
 * tolerance can be configured per facility without changing this helper.
 */
export function matchesThreeWay(
  order: { quantity: number; unitCostCents: number },
  receipt: { quantity: number; unitCostCents: number },
  invoice: { quantity: number; unitCostCents: number },
): boolean {
  return (
    order.quantity === invoice.quantity &&
    receipt.quantity === invoice.quantity &&
    order.unitCostCents === invoice.unitCostCents &&
    receipt.unitCostCents === invoice.unitCostCents
  );
}
