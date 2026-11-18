import { NextRequest } from "next/server";

import { voidInvoice, type VoidInvoiceInput } from "@/server/commands/billing";

import { handleCashierCommand } from "../../_shared";

export async function POST(request: NextRequest) {
  return handleCashierCommand<VoidInvoiceInput, unknown>(request, "Invalid void", voidInvoice);
}
