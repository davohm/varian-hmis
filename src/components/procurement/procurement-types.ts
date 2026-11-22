import { formatDate, formatMoney, todayIso } from "@/components/finance/finance-types";

export type ProcurementTab =
  | "overview"
  | "suppliers"
  | "requisitions"
  | "sourcing"
  | "orders"
  | "receiving"
  | "invoices"
  | "stock";

export interface ProcurementOverview {
  pendingRequisitions: number;
  openPurchaseOrders: number;
  unpaidInvoiceCount: number;
  unpaidInvoiceAmount: string;
  stockValue: string;
  reorderAlerts: number;
}

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

export interface ItemRow {
  id: string;
  code: string;
  name: string;
  unit: string;
}

export interface StoreRow {
  id: string;
  name: string;
  kind: string;
}

export interface DocumentLine {
  id: string;
  itemId: string;
  itemName?: string;
  quantity: number;
  receivedQuantity?: number;
  unitCost?: string;
  lineTotal?: string;
  batchNo?: string | null;
  expiryDate?: string | null;
  purchaseOrderLineId?: string;
  goodsReceiptLineId?: string;
  note?: string | null;
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
  approvedAt: string | null;
  createdAt: string;
}

export interface RequisitionDetail extends RequisitionRow {
  lines: DocumentLine[];
  approvals: Array<{
    id: string;
    decision: string;
    actorId: string;
    reason: string | null;
    decidedAt: string;
  }>;
}

export interface RfqRow {
  id: string;
  rfqNo: string;
  requisitionId: string;
  status: string;
  closingDate: string | null;
  issuedBy: string;
  createdAt: string;
}

export interface RfqDetail extends RfqRow {
  lines: DocumentLine[];
  quotes: QuoteRow[];
}

export interface QuoteRow {
  id: string;
  rfqId: string;
  supplierId: string;
  supplierName: string;
  quoteNo: string | null;
  status: string;
  totalAmount: string;
  receivedAt: string;
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
  approvedAt: string | null;
  expectedDate: string | null;
  createdAt: string;
}

export interface PurchaseOrderDetail extends PurchaseOrderRow {
  lines: DocumentLine[];
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
  receivedAt: string;
  status: string;
}

export interface GoodsReceiptDetail extends GoodsReceiptRow {
  lines: DocumentLine[];
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

export interface SupplierInvoiceDetail extends SupplierInvoiceRow {
  lines: DocumentLine[];
  payments: Array<{
    id: string;
    paymentNo: string;
    amount: string;
    method: string;
    paymentDate: string;
    recordedBy: string;
  }>;
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

export interface ExpiryRow {
  batchId: string;
  itemName: string;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
}

export interface VarianceRow {
  purchaseOrderId: string;
  poNo: string;
  goodsReceiptId: string;
  grnNo: string;
  orderedAmount: string;
  receivedAmount: string;
  invoicedAmount: string;
}

export interface ProcurementData {
  overview: ProcurementOverview | null;
  suppliers: SupplierRow[];
  requisitions: RequisitionRow[];
  requisitionDetail: RequisitionDetail | null;
  rfqs: RfqRow[];
  rfqDetail: RfqDetail | null;
  quotes: QuoteRow[];
  purchaseOrders: PurchaseOrderRow[];
  purchaseOrderDetail: PurchaseOrderDetail | null;
  goodsReceipts: GoodsReceiptRow[];
  goodsReceiptDetail: GoodsReceiptDetail | null;
  supplierInvoices: SupplierInvoiceRow[];
  supplierInvoiceDetail: SupplierInvoiceDetail | null;
  supplierPayments: SupplierPaymentRow[];
  items: ItemRow[];
  stores: StoreRow[];
  reorderRows: ReorderRow[];
  stockValuation: StockValuationRow[];
  expiryReport: ExpiryRow[];
  varianceReport: VarianceRow[];
}

export type RunProcurementCommand = (
  command: string,
  input: Record<string, unknown>,
  successMessage: string,
) => Promise<boolean>;

export interface ProcurementPanelProps {
  data: ProcurementData;
  canWrite: boolean;
  busy: boolean;
  run: RunProcurementCommand;
  refresh: () => Promise<void>;
  selectRequisition: (id: string) => void;
  selectRfq: (id: string) => void;
  selectPurchaseOrder: (id: string) => void;
  selectGoodsReceipt: (id: string) => void;
  selectSupplierInvoice: (id: string) => void;
}

export class ProcurementCommandError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "ProcurementCommandError";
  }
}

/** Posts a scoped procurement command. Facility and actor are injected by the API. */
export async function postProcurementCommand<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("/api/procurement", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "procurement-station" },
    body: JSON.stringify({ command, input }),
  });
  const body = (await response.json().catch(() => null)) as {
    result?: T;
    error?: string;
    issues?: Array<{ message?: string; path?: Array<string | number> }>;
  } | null;
  if (!response.ok || !body) {
    const issues = (body?.issues ?? [])
      .map((issue) =>
        issue.path && issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message ?? "invalid"}`
          : (issue.message ?? "invalid"),
      )
      .filter(Boolean);
    throw new ProcurementCommandError(body?.error ?? `Request failed (${response.status})`, issues);
  }
  return body.result as T;
}

export const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export const SUBTLE_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-transform duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export { formatDate, formatMoney, todayIso };
