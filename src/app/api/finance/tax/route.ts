import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { FINANCE_READ_ROLES, FINANCE_WRITE_ROLES } from "@/lib/navigation";
import { apiErrorResponse } from "@/server/auth/api-error";
import { requireApiFacility } from "@/server/auth/api-context";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/guards";
import {
  cancelEtimsInvoice,
  enqueueEtimsInvoice,
  finalizeInvoice,
  generateEtimsSignature,
  getEtimsInvoiceStatus,
  reconcileEtimsQueue,
  retryEtimsInvoice,
  transmitEtimsInvoice,
  upsertTaxCode,
} from "@/server/commands/tax";
import { db } from "@/server/db/client";
import {
  getEtimsSummary,
  getEtimsTransactionDetail,
  listEtimsIntegrations,
  listEtimsTransactions,
  listFinalisableInvoices,
  listTaxCodes,
  transactionFilterSchema,
} from "@/server/queries/tax";

import { handleErpCommand } from "../_shared";

export const dynamic = "force-dynamic";

type TaxCommand = (input: Record<string, unknown>) => Promise<unknown>;

const commands: Record<string, TaxCommand> = {
  upsertTaxCode: (input) => upsertTaxCode(input as Parameters<typeof upsertTaxCode>[0]),
  finalizeInvoice: (input) => finalizeInvoice(input as Parameters<typeof finalizeInvoice>[0]),
  enqueueEtimsInvoice: (input) =>
    enqueueEtimsInvoice(input as Parameters<typeof enqueueEtimsInvoice>[0]),
  transmitEtimsInvoice: (input) =>
    transmitEtimsInvoice(input as Parameters<typeof transmitEtimsInvoice>[0]),
  retryEtimsInvoice: (input) => retryEtimsInvoice(input as Parameters<typeof retryEtimsInvoice>[0]),
  cancelEtimsInvoice: (input) => cancelEtimsInvoice(input as Parameters<typeof cancelEtimsInvoice>[0]),
  generateEtimsSignature: (input) =>
    generateEtimsSignature(input as Parameters<typeof generateEtimsSignature>[0]),
};

const statusFilterSchema = z.object({
  view: z.literal("status").optional(),
  queueId: z.uuid().optional(),
  invoiceNo: z.string().trim().max(40).optional(),
});

const reconcileFilterSchema = z.object({
  view: z.literal("reconcile"),
  staleSeconds: z.coerce.number().int().min(1).max(86_400).default(900),
  environment: z.enum(["sandbox", "production"]).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { facilityId } = await requireApiFacility(FINANCE_READ_ROLES);
    const url = new URL(request.url);
    const rawView = url.searchParams.get("view");
    const params = Object.fromEntries(url.searchParams.entries());

    if (rawView === "status") {
      const filter = statusFilterSchema.parse(params);
      const status = await getEtimsInvoiceStatus({
        facilityId,
        queueId: filter.queueId,
        invoiceNo: filter.invoiceNo,
      });
      return NextResponse.json({ status });
    }

    if (rawView === "reconcile") {
      const filter = reconcileFilterSchema.parse(params);
      const reconciliation = await reconcileEtimsQueue({
        facilityId,
        staleSeconds: filter.staleSeconds,
        environment: filter.environment,
      });
      return NextResponse.json({ reconciliation });
    }

    const filters = transactionFilterSchema.parse({
      status: url.searchParams.get("status") || undefined,
      documentType: url.searchParams.get("documentType") || undefined,
      environment: url.searchParams.get("environment") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      search: url.searchParams.get("search") || undefined,
      queueId: url.searchParams.get("queueId") || undefined,
    });

    const [transactions, detail, taxCodes, invoices, integrations, summary] = await Promise.all([
      listEtimsTransactions(db, facilityId, filters),
      filters.queueId
        ? getEtimsTransactionDetail(db, facilityId, filters.queueId)
        : Promise.resolve(null),
      listTaxCodes(db, facilityId),
      listFinalisableInvoices(db, facilityId),
      listEtimsIntegrations(db, facilityId),
      getEtimsSummary(db, facilityId),
    ]);

    return NextResponse.json({
      transactions,
      detail,
      taxCodes,
      invoices,
      integrations,
      summary,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid tax filters", issues: error.issues }, { status: 400 });
    }
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiErrorResponse(error);
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  return handleErpCommand(
    request,
    FINANCE_WRITE_ROLES,
    commands,
    "Invalid tax command",
  );
}
