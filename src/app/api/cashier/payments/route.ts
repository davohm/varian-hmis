import { NextRequest } from "next/server";

import { takePayment, type TakePaymentInput } from "@/server/commands/billing";

import { handleCashierCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleCashierCommand<TakePaymentInput, unknown>(request, "Invalid payment", takePayment);
}
