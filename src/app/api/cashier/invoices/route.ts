import { NextRequest } from "next/server";

import { openInvoice, type OpenInvoiceInput } from "@/server/commands/billing";

import { handleCashierCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleCashierCommand<OpenInvoiceInput, unknown>(request, "Invalid invoice", openInvoice);
}
