import { NextRequest } from "next/server";

import { reversePayment, type ReversePaymentInput } from "@/server/commands/billing";

import { handleCashierCommand } from "../../_shared";

export async function POST(request: NextRequest) {
  return handleCashierCommand<ReversePaymentInput, unknown>(
    request,
    "Invalid reversal",
    reversePayment,
  );
}
