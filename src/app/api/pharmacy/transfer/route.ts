import { NextRequest } from "next/server";

import { transferStock, type TransferStockInput } from "@/server/commands/pharmacy";

import { handlePharmacyCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handlePharmacyCommand<TransferStockInput, unknown>(
    request,
    "Invalid stock transfer",
    transferStock,
  );
}
